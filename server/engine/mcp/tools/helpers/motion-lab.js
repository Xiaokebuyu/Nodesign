/**
 * helpers/motion-lab.js — 时间维度感知（2026-08-19，问题库 iss_mszv782a_toab）
 *
 * ## 为什么有这一层
 *
 * agent 的眼睛一直只有静帧，而动画/演出类工作的好坏**全在时间轴上**：缓动像不像
 * 机械臂、过冲回稳够不够、两个 tween 之间有没有硬切、低帧率下衰减是不是按帧写的。
 * 上报里的四条真实代价：装弹位姿写到镜头背后、倒地绕错轴转进桌底、枪口白闪按帧
 * 衰减 —— 前三条是**碰巧**在静帧上暴露的，第四类纯时间问题一条都抓不到。
 *
 * 这层给三条通道，共用一次录制：
 *   - 胶片条：CDP screencast 录一段，按请求时刻取最近帧拼 contact sheet（眼睛）
 *   - 数值示波器：rAF 逐帧采样任意 JS 表达式，报过冲/稳定时间/硬切（仪表）
 *   - 帧健康 + 音频事件：rAF 间隔统计、play()/start() 时刻表（顺带白拿）
 *
 * ## 录制方式为什么是 screencast 不是连拍 page.screenshot
 *
 * page.screenshot 一张 100~300ms，帧与帧的间距根本压不进 120ms —— 拿它连拍
 * 得到的是"每张都晚点、晚多少不知道"的时间轴。Page.startScreencast 是渲染进程
 * **每次重绘推一帧**，帧上带 epoch 时间戳，事后挑最近帧，时刻是真的。
 *
 * ⚠️ 观察者效应：1 vCPU 上 screencast 的 jpeg 编码自己就吃帧。帧健康数字只用于
 *    A/B 与"有没有 100ms+ 冻结"这种量级判断，别当用户设备的绝对值报。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeServerTmpDir } from '../../../../lib/server-tmp.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ── 纯函数（可单测）─────────────────────────────────────────────

/**
 * 请求时刻 → 该时刻**屏幕上真正显示的帧**。frames: [{tMs, ...}]，wanted: number[]。
 *
 * 语义是 last-≤-want 不是 nearest：screencast 只在重绘时推帧，屏幕在时刻 t
 * 显示的内容严格等于"最后一次 ≤t 的合成帧"。nearest 有两个真 bug（真跑校验
 * 逮到的）：t=0 会取到触发后 13ms 的帧（起手式已经开动），动画停稳后的请求点
 * 会报"误差 289ms"—— 其实那 289ms 里屏幕纹丝没动，最后一帧就是正确画面。
 * +8ms 容差吃掉合成与时间戳之间的抖动。同一帧可被多个时刻共用。
 */
export function pickNearestFrames(frames, wanted) {
  const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
  return wanted.map((want) => {
    let best = null;
    for (const f of sorted) {
      if (f.tMs <= want + 8) best = f;
      else break;
    }
    if (!best) best = sorted[0] || null;   // 请求点比第一帧还早：给第一帧
    return best ? { want, actual: best.tMs, frame: best } : null;
  });
}

/**
 * 拼图布局（08-21 按新视觉档重算）：预算 2.3MP（实测一张 ≈3.0~3.7k token，旧档 1.05MP 是 07-29 按
 * 1.15MP 定的）+ **长边 ≤2000**（否则 normalizeShot 又整体缩回去，白给）。列数不再按
 * 阶梯死规定，而是在两条约束下**挑格子面积最大**的那种排法 —— 格数从 2 到 30 都能拼，
 * 格数越多每格越小，这是 agent 自己权衡的事（描述里说清）。
 */
export function sheetLayout(n, frameW, frameH, { maxPixels = 2_300_000, maxEdge = 2000, gap = 6 } = {}) {
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    // 三条上限取最严：总像素、横向长边、纵向长边
    const sPix = Math.sqrt(maxPixels / (n * frameW * frameH));
    const sW = (maxEdge - (cols + 1) * gap) / (cols * frameW);
    const sH = (maxEdge - (rows + 1) * gap) / (rows * frameH);
    const scale = Math.min(1, sPix, sW, sH);
    const cellW = Math.max(80, Math.round(frameW * scale));
    const cellH = Math.max(45, Math.round(frameH * scale));
    const area = cellW * cellH;
    // 面积相同（都被总像素卡住）时取更方正的排法：阅读顺序更像时间轴
    const squareness = -Math.abs((cols * cellW) - (rows * cellH));
    if (!best || area > best.area + 1 || (Math.abs(area - best.area) <= 1 && squareness > best.squareness)) {
      best = { cols, rows, cellW, cellH, area, squareness };
    }
  }
  const { cols, rows, cellW, cellH } = best;
  return {
    cols, rows, cellW, cellH, gap,
    sheetW: cols * cellW + (cols + 1) * gap,
    sheetH: rows * cellH + (rows + 1) * gap,
  };
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** rAF 时间戳序列 → 帧健康报告。头两帧含启动抖动，剔掉。 */
export function frameHealth(rafTs) {
  const iv = [];
  for (let i = 3; i < rafTs.length; i += 1) iv.push(rafTs[i] - rafTs[i - 1]);
  if (iv.length < 10) return { ok: false, n: iv.length };
  const worst = Math.max(...iv);
  return {
    ok: true,
    n: iv.length,
    fps: 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length),
    p50: pct(iv, 50),
    p95: pct(iv, 95),
    worst,
    droppedPct: (iv.filter((f) => f > 16.7 * 1.5).length / iv.length) * 100,
    freezes: iv.filter((f) => f > 120).length,
  };
}

/**
 * 一条采样曲线 → 数值报告。points: [{t, v}]（t 毫秒、相对触发时刻，v 数值）。
 *
 * 判读逻辑（都是"给 agent 一个开工方向"级别，不是学术级）：
 *   final     = 末尾 10% 样本的中位数（动画应该已经停了）
 *   overshoot = 相对"起点→终点"行程，越过终点最远多少 %（缓动手感的核心数字）
 *   settleMs  = 最后一次离 final 超过行程 3% 的时刻（之后就算稳住了）
 *   cuts      = 单帧（≤40ms 间隔）内跳变超过全程 22% 的时刻 —— 两个 tween 之间
 *               的硬切、瞬移、状态机跳变都长这样
 */
export function seriesReport(points) {
  const pts = points.filter((p) => Number.isFinite(p.v));
  if (pts.length < 8) return { ok: false, n: pts.length };
  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const range = max - min;
  const tail = vs.slice(Math.max(0, Math.floor(vs.length * 0.9)));
  const final = [...tail].sort((a, b) => a - b)[Math.floor(tail.length / 2)];
  const first = vs[0];
  const travel = Math.abs(final - first);

  let overshootPct = 0;
  if (travel > 1e-9) {
    const beyond = final >= first ? max - final : final - min;
    overshootPct = Math.max(0, (beyond / travel) * 100);
  }

  let settleMs = 0;
  if (travel > 1e-9) {
    const tol = travel * 0.03;
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      if (Math.abs(pts[i].v - final) > tol) { settleMs = pts[i].t; break; }
    }
  }

  const cuts = [];
  if (range > 1e-9) {
    for (let i = 1; i < pts.length; i += 1) {
      const dt = pts[i].t - pts[i - 1].t;
      const dv = Math.abs(pts[i].v - pts[i - 1].v);
      if (dt > 0 && dt <= 40 && dv > range * 0.22) cuts.push(Math.round(pts[i].t));
    }
  }
  // 相邻帧连续跳变是同一次瞬移，收拢成一条
  const cutTimes = cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 60).slice(0, 4);

  return {
    ok: true, n: pts.length, first, final, min, max, range,
    overshootPct, settleMs, cuts: cutTimes,
    still: range < Math.max(1e-9, Math.abs(final) * 1e-6) || range === 0,
  };
}

const CHART_COLORS = ['#e4572e', '#2e86ab', '#5c9e31', '#8a4fff', '#d81159', '#0f8b8d'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 多条曲线 → 一张 SVG 折线图（各自归一化到 0..1，图例标真实范围）。
 * 硬切时刻画红色虚线。给 sharp 转位图用，字体走系统缺省。
 */
export function chartSvg(seriesList, durationMs, { width = 1180, height = 460 } = {}) {
  const padL = 56; const padR = 16; const padT = 14; const padB = 40 + seriesList.length * 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const x = (t) => padL + (t / Math.max(1, durationMs)) * plotW;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="#fafaf7" stroke="#ddd"/>`,
  ];

  // 时间刻度：挑个整步长，8~14 格
  const step = [50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => durationMs / s <= 14) || 5000;
  for (let t = 0; t <= durationMs; t += step) {
    parts.push(`<line x1="${x(t)}" y1="${padT}" x2="${x(t)}" y2="${padT + plotH}" stroke="#e8e8e2" stroke-width="1"/>`);
    parts.push(`<text x="${x(t)}" y="${padT + plotH + 16}" font-size="12" text-anchor="middle" fill="#666" font-family="sans-serif">${t}ms</text>`);
  }

  seriesList.forEach((s, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const r = s.report;
    const lo = r.min; const span = (r.max - r.min) || 1;
    const y = (v) => padT + plotH - ((v - lo) / span) * (plotH - 8) - 4;
    // 降采样到 ≤300 点，SVG 别写成兆
    const pts = s.points.filter((p) => Number.isFinite(p.v));
    const stride = Math.max(1, Math.ceil(pts.length / 300));
    const d = pts.filter((_, j) => j % stride === 0 || j === pts.length - 1)
      .map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`);
    for (const ct of r.cuts || []) {
      parts.push(`<line x1="${x(ct)}" y1="${padT}" x2="${x(ct)}" y2="${padT + plotH}" stroke="#d81a1a" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    }
    const ly = padT + plotH + 34 + i * 20;
    parts.push(`<rect x="${padL}" y="${ly - 10}" width="14" height="4" fill="${color}"/>`);
    parts.push(`<text x="${padL + 20}" y="${ly - 4}" font-size="13" fill="#333" font-family="sans-serif">${esc(s.name)}: ${fmtNum(r.first)} → ${fmtNum(r.final)}  (min ${fmtNum(r.min)}, max ${fmtNum(r.max)})</text>`);
  });

  parts.push('</svg>');
  return parts.join('\n');
}

export function fmtNum(v) {
  if (!Number.isFinite(v)) return '?';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

// ── 页面内采样器（page.evaluate 序列化过去跑）──────────────────────

/* eslint-disable no-undef */
function installMotionSampler(cfg) {
  const st = {
    running: true, raf: 0, rafTs: [], rows: [], errs: {}, audio: [],
    timeOrigin: performance.timeOrigin,
  };
  window.__ndMotion = st;

  const fns = {};
  for (const name of Object.keys(cfg.exprs || {})) {
    try {
      fns[name] = new Function(`return (${cfg.exprs[name]});`);
    } catch (e) { st.errs[name] = `compile: ${e.message}`; }
  }

  // 音频事件钩子：agent 听不见声音，但"什么时刻试图出声"是可记录的。
  // play() 被 autoplay 政策拒掉也照记 —— "试图出声但被拒"本身就是发现。
  try {
    const note = (what) => { if (st.audio.length < 40) st.audio.push({ t: performance.now(), what }); };
    const wrap = (proto, method, desc) => {
      const orig = proto && proto[method];
      if (!orig) return;
      proto[method] = function (...a) { try { note(desc(this)); } catch { /* */ } return orig.apply(this, a); };
    };
    wrap(HTMLMediaElement.prototype, 'play', (el) => `media.play ${((el.currentSrc || el.src || '').split('/').pop() || el.tagName.toLowerCase()).slice(0, 48)}`);
    wrap(AudioBufferSourceNode.prototype, 'start', () => 'audioBufferSource.start');
    wrap(OscillatorNode.prototype, 'start', () => 'oscillator.start');
  } catch { /* 没有 WebAudio 的环境 */ }

  // 元素探针（08-21）：不用 agent 写表达式，自动盯一批"可能在动"的元素，逐帧采
  // 文档坐标 / 透明度 / 缩放。文档坐标 = 视口 rect + scroll，所以滚动本身不算"动"，
  // 视差 / 入场 / 固定元素随视口走的才算。参考站的全局 agent 不认识，这是它唯一能
  // 拿到"谁在动、怎么动"的路。
  st.elems = [];
  if (cfg.probeElements) {
    try {
      const picked = [];
      const seen = new Set();
      const add = (el) => { if (picked.length >= 48 || seen.has(el)) return; const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 24) return; seen.add(el); picked.push(el); };
      const vh = window.innerHeight;
      // 先挑声明了会动的（will-change / transition / animation），再补视口附近的大块
      for (const el of document.querySelectorAll('*')) {
        if (picked.length >= 32) break;
        const r = el.getBoundingClientRect();
        if (r.bottom < -vh || r.top > vh * 2) continue;
        const cs = getComputedStyle(el);
        if (cs.willChange !== 'auto' || cs.animationName !== 'none' || (cs.transitionDuration !== '0s' && cs.transitionProperty !== 'none')) add(el);
      }
      for (const el of document.querySelectorAll('section, article, header, h1, h2, figure, img, video, canvas, [class*="hero"], [class*="card"], nav')) {
        if (picked.length >= 48) break;
        const r = el.getBoundingClientRect();
        if (r.bottom < -vh || r.top > vh * 2) continue;
        add(el);
      }
      const selOf = (el) => { const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''; return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`; };
      // fixed/sticky 要沿祖先看：固定头部里的链接自己是 static，但整层随视口走
      const fixedOf = (el) => { for (let n = el, i = 0; n && n.nodeType === 1 && i < 40; n = n.parentElement, i += 1) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
      st.elems = picked.map((el) => ({ el, sel: selOf(el), fixed: fixedOf(el), samples: [] }));
    } catch { st.elems = []; }
  }
  const sampleElems = (now) => {
    for (const e of st.elems) {
      if (e.samples.length >= 600) continue;
      try {
        const r = e.el.getBoundingClientRect();
        const cs = getComputedStyle(e.el);
        let s = 1;
        const m = cs.transform && cs.transform !== 'none' ? cs.transform.match(/matrix\(([^)]+)\)/) : null;
        if (m) { const p = m[1].split(',').map(Number); s = Math.hypot(p[0], p[1]); }
        e.samples.push([Math.round(now), Math.round(r.left + window.scrollX), Math.round(r.top + window.scrollY), Number(cs.opacity), Number(s.toFixed(3))]);
      } catch { /* 元素没了就不采 */ }
    }
  };

  const hasExprs = Object.keys(fns).length > 0;
  const tick = () => {
    if (!st.running) return;
    const now = performance.now();
    if (st.rafTs.length < 4000) st.rafTs.push(now);
    if (st.elems.length) sampleElems(now);
    if (hasExprs && st.rows.length < 4000) {
      const row = { t: now };
      for (const k in fns) {
        try {
          const v = fns[k]();
          const num = typeof v === 'number' ? v : Number(v);
          if (Number.isFinite(num)) row[k] = num;
          else { row[k] = null; if (!(k in st.errs)) st.errs[k] = `value not numeric: ${String(v).slice(0, 60)}`; }
        } catch (e) {
          row[k] = null;
          if (!(k in st.errs)) st.errs[k] = String(e && e.message || e).slice(0, 120);
        }
      }
      st.rows.push(row);
    }
    st.raf = requestAnimationFrame(tick);
  };
  st.raf = requestAnimationFrame(tick);
  return true;
}

function collectMotionSampler() {
  const st = window.__ndMotion;
  if (!st) return null;
  st.running = false;
  cancelAnimationFrame(st.raf);
  return {
    timeOrigin: st.timeOrigin,
    rafTs: st.rafTs,
    rows: st.rows,
    errs: st.errs,
    audio: st.audio,
    elems: (st.elems || []).map((e) => ({ sel: e.sel, fixed: e.fixed, samples: e.samples })),
  };
}
/* eslint-enable no-undef */

// ── 录制主流程 ───────────────────────────────────────────────────

/**
 * 在已就位的 page 上录一段：装采样器 →（可选 click / trigger）→ 等 durationMs →
 * 收数。wantShots 为真才开 screencast（trace_motion 纯数值时省下 jpeg 编码那份 CPU）。
 *
 * 返回 {
 *   shots: [{tMs, buf}]           tMs 相对触发时刻（可为负 = 触发前的画面）
 *   rafTs, rows, errs, audio      页面采样（rows/audio 的 t 已换算成相对触发时刻）
 *   clickNote, triggerNote        动作失败时的说明（不失败为 null）
 *   captureNote                   screencast 密度说明
 * }
 */
export async function recordMotion(page, {
  durationMs, trigger, click, expressions, during = null, probeElements = false,
  wantShots = true, shotMaxW = 1152, shotMaxH = 1152, shotQuality = 78,
}) {
  // during（08-21）：t=0 之后、录制期间并行跑的一段动作（典型：真滚轮滚一段，见
  // motion-scroll.js 的 wheelScroll）。它跟 trigger 的区别：trigger 是页面里的 JS，
  // during 是 Playwright 侧的输入事件 —— 滚动劫持那族只认后者。
  await page.evaluate(installMotionSampler, { exprs: expressions || {}, probeElements });

  const shots = [];
  let cdp = null;
  if (wantShots) {
    cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', (ev) => {
      if (shots.length < 900) {
        shots.push({ epochMs: ev.metadata.timestamp * 1000, buf: Buffer.from(ev.data, 'base64') });
      }
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: shotQuality, everyNthFrame: 1,
      maxWidth: shotMaxW, maxHeight: shotMaxH,
    });
    // 触发前先攒一两帧：t=0 的"起点画面"从这里来
    await page.waitForTimeout(150);
  }

  let clickNote = null;
  let triggerNote = null;
  const t0 = Date.now();                    // ← 时刻零：第一个动作派发的瞬间
  if (click) {
    try {
      await page.click(click, { timeout: 2500, noWaitAfter: true });
    } catch (e) { clickNote = `click "${click}" failed: ${String(e?.message || e).split('\n')[0]}`; }
  }
  let trigP = null;
  if (trigger) {
    trigP = page.evaluate(`(async () => { ${trigger} })()`)
      .catch((e) => { triggerNote = `trigger error: ${e?.message || e}`; });
  }
  let duringNote = null;
  let duringP = null;
  if (typeof during === 'function') {
    duringP = Promise.resolve().then(() => during(page))
      .then((note) => { if (typeof note === 'string') duringNote = note; })
      .catch((e) => { duringNote = `during error: ${e?.message || e}`; });
  }

  await page.waitForTimeout(durationMs + 100);
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  if (trigP) await Promise.race([trigP, new Promise((r) => { setTimeout(r, 10); })]);
  // during 是按时间预算自己收尾的（wheelScroll 按 elapsed 配额派发），多等一秒拿它的说明
  if (duringP) await Promise.race([duringP, new Promise((r) => { setTimeout(r, 1000); })]);

  const raw = await page.evaluate(collectMotionSampler);
  if (!raw) throw new Error('motion sampler vanished from the page (a reload during recording?)');

  const rel = (perfNow) => (raw.timeOrigin + perfNow) - t0;
  return {
    shots: shots.map((s) => ({ tMs: s.epochMs - t0, buf: s.buf }))
      .sort((a, b) => a.tMs - b.tMs),
    rafTs: raw.rafTs,
    rows: raw.rows.map((r) => ({ ...r, t: rel(r.t) })),
    errs: raw.errs,
    audio: raw.audio.map((a) => ({ t: rel(a.t), what: a.what })),
    elems: (raw.elems || []).map((e) => ({ ...e, samples: e.samples.map((s) => [Math.round(rel(s[0])), s[1], s[2], s[3], s[4]]) })),
    clickNote,
    triggerNote,
    duringNote,
    captureNote: wantShots
      ? `screencast captured ${shots.length} frames over ${((durationMs + 250) / 1000).toFixed(1)}s`
        + (shots.length < 2 ? ' — the page never repainted; is anything actually animating?' : '')
      : null,
  };
}

/**
 * 挑好的帧 → 一张带时间戳标注的 contact sheet（png buffer）。
 * crop（可选）= {x,y,w,h}，**CSS 视口坐标系**；screencast 帧是视口按 maxW 缩过的，
 * 这里用 帧宽/cropRefW 把裁剪框换算到帧坐标（调用方传 cropRefW = viewport 宽）。
 */
export async function composeSheet(picked, { crop = null, cropRefW = null } = {}) {
  const { default: sharp } = await import('sharp');
  const valid = picked.filter(Boolean);
  if (!valid.length) throw new Error('no frames captured to compose');

  const meta = await sharp(valid[0].frame.buf).metadata();
  let srcW = meta.width; let srcH = meta.height;
  let extract = null;
  if (crop && cropRefW) {
    const k = meta.width / cropRefW;
    const left = Math.max(0, Math.round(crop.x * k));
    const top = Math.max(0, Math.round(crop.y * k));
    extract = {
      left,
      top,
      width: Math.max(8, Math.min(Math.round(crop.w * k), srcW - left)),
      height: Math.max(8, Math.min(Math.round(crop.h * k), srcH - top)),
    };
    srcW = extract.width; srcH = extract.height;
  }

  const L = sheetLayout(valid.length, srcW, srcH);
  const composites = [];
  const labels = [];
  for (let i = 0; i < valid.length; i += 1) {
    const col = i % L.cols; const row = Math.floor(i / L.cols);
    const left = L.gap + col * (L.cellW + L.gap);
    const top = L.gap + row * (L.cellH + L.gap);
    let img = sharp(valid[i].frame.buf);
    if (extract) img = img.extract(extract);
    composites.push({
      input: await img.resize(L.cellW, L.cellH, { fit: 'fill' }).png().toBuffer(),
      left, top,
    });
    const want = Math.round(valid[i].want);
    const actual = Math.round(valid[i].actual);
    // painted = 这帧实际合成的时刻；差得远 = 这段时间页面没重绘（画面就是没变）
    const label = Math.abs(actual - want) <= 12 ? `t=${want}ms` : `t=${want}ms (painted ${actual})`;
    labels.push({ left, top, label });
  }

  const fontH = Math.max(13, Math.round(L.cellH * 0.055));
  const labelSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.sheetW}" height="${L.sheetH}">`,
    ...labels.map((l) => {
      const w = l.label.length * fontH * 0.62 + 12;
      return `<rect x="${l.left}" y="${l.top}" width="${w.toFixed(0)}" height="${fontH + 10}" fill="#000" fill-opacity="0.72"/>`
        + `<text x="${l.left + 6}" y="${l.top + fontH + 2}" font-size="${fontH}" fill="#fff" font-family="monospace">${esc(l.label)}</text>`;
    }),
    '</svg>',
  ].join('');

  const buf = await sharp({
    create: { width: L.sheetW, height: L.sheetH, channels: 3, background: '#15150f' },
  })
    .composite([...composites, { input: Buffer.from(labelSvg), left: 0, top: 0 }])
    .png()
    .toBuffer();
  return { buf, layout: L };
}

/**
 * 录到的全部帧 → webm（vp8，给**用户**看的真动图；模型视觉通道只吃静帧）。
 * ffmpeg concat demuxer 按真实帧间距排时刻，不匀速化 —— 卡顿保真。
 */
export async function encodeWebm(shots, outAbs) {
  if (shots.length < 2) throw new Error('need at least 2 captured frames to encode video');
  const tmp = await makeServerTmpDir('nd-motion-');
  try {
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < shots.length; i += 1) {
      const f = path.join(tmp, `f${String(i).padStart(4, '0')}.jpg`);
      await fs.writeFile(f, shots[i].buf);
      const dur = i + 1 < shots.length
        ? Math.max(0.008, (shots[i + 1].tMs - shots[i].tMs) / 1000)
        : 0.35;
      lines.push(`file '${f}'`, `duration ${dur.toFixed(4)}`);
    }
    const list = path.join(tmp, 'list.txt');
    await fs.writeFile(list, lines.join('\n'));
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    // ⛔ 不用 execFileSync：会冻死事件循环（docx 引擎那边真踩过）
    await execFileP('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8',
      '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      outAbs,
    ], { timeout: 60_000 });
    const st = await fs.stat(outAbs);
    return { bytes: st.size };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** 帧健康 + 音频事件 → caption 文本行（两个工具共用同一份措辞）。 */
export function motionCaptionLines(rec) {
  const lines = [];
  const fh = frameHealth(rec.rafTs);
  if (fh.ok) {
    lines.push(
      `frame health: ~${fh.fps.toFixed(0)}fps, p95 ${fh.p95.toFixed(1)}ms, worst ${fh.worst.toFixed(0)}ms`
      + `, ${fh.droppedPct.toFixed(0)}% frames >25ms`
      + (fh.freezes ? `, ${fh.freezes} freeze(s) >120ms` : '')
      + ' (1-vCPU box + recording overhead — read as A/B and orders of magnitude, not as the user device)',
    );
  }
  if (rec.audio.length) {
    lines.push(`audio events: ${rec.audio.slice(0, 8).map((a) => `${Math.round(a.t)}ms ${a.what}`).join(' · ')}`
      + (rec.audio.length > 8 ? ` (+${rec.audio.length - 8} more)` : ''));
  }
  if (rec.captureNote) lines.push(rec.captureNote);
  if (rec.clickNote) lines.push(rec.clickNote);
  if (rec.triggerNote) lines.push(rec.triggerNote);
  if (rec.duringNote) lines.push(rec.duringNote);
  return lines;
}
