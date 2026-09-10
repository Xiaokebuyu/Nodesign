/**
 * helpers/shot-pipeline.js — 截图管线的纯 helper（2026-08-19 从 screenshot.js 拆出，行数棘轮）
 *
 * screenshot_canvas / screenshot_url / browse 共用的一段：出图归一化、渲染保真探针、
 * 页面诊断收集（console / 失败请求）、waitFor / beforeShot 等待语义。
 * 全部只依赖 playwright Page 与 sharp，不碰工作区寻址 —— 拆出来是搬家不是重写。
 */

// ── 出图归一化（2026-07-29 立，2026-08-21 按新视觉档重算）──
// 背景：fullPage 截长站点页时 PNG 会超 API 的图片上限，整个工具调用直接报错；
// 本地先缩到模型真用得上的规格，传输体积小一个量级、永远不触发上限。编码统一 webp。
//
// 08-21 重算（会话模型 Opus 5 / Sonnet 5 / Opus 4.7+ 都是高分辨率档）：
//   - 该档位 token = ⌈w/28⌉ × ⌈h/28⌉，上限 4784 token ≈ 3.75MP；长边上限 2576。
//     旧值 1568 / 1.15MP 是 Opus 4.6 及以前的档，对现役模型是把画面白白缩掉 40% 长边。
//   - 长边**定 2000 不定 2576**：一个请求里超过 20 张图时，每张都按"任一边 ≤2000px"
//     严格限制（否则整个请求被拒）。agent 会话里截图攒到 20 张以上是常态，2000 是
//     无论上下文里有多少张都安全的值。代价：极端长图（1440 宽的整页站）长边压到 2000，
//     仍比旧的 1568 多 27%。
//   - 非订阅通路（中转 gemini / 本地 qwen）在 model-ingress 另有 VISION_MAX_DIM=1568
//     再压一道，这里放宽不影响它们。
//   - 成本：1366×768 → 49×28=1372 token（旧算法 1399，几乎不变）；1920×1080 全幅
//     → 69×39=2691（旧档会先缩到 1568×882 → 1792）；2000×1125 → 72×41=2952。
const API_LONG_EDGE = 2000;
const API_MAX_PIXELS = 3_750_000;
/** 导出给"坐标 1:1"断言和产物会话的 frame 计算用（两处都要和这里同一套算法） */
export const API_IMAGE_LIMITS = { longEdge: API_LONG_EDGE, maxPixels: API_MAX_PIXELS };
/** 高分辨率档的 token 估算（⌈w/28⌉×⌈h/28⌉），给 caption 报成本用 */
export const visionTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
/**
 * 出图会被缩多少（1 = 不缩）。**模型读到的坐标就是缩完那张图的像素**，所以凡是
 * 要把截图坐标换回页面坐标的地方（frame.scale）必须问这一份 —— 上面那句
 * 「两处都要和这里同一套算法」原来只是句注释，抄漏一次就是坐标整体错位。
 */
export const shotScale = (w, h) => (w > 0 && h > 0
  ? Math.min(1, API_LONG_EDGE / Math.max(w, h), Math.sqrt(API_MAX_PIXELS / (w * h)))
  : 1);

// ── 渲染层保真（2026-08-07）──
// 2026-08-05 事故：一次 screenshot_canvas 的位图整体呈暗色反转（深棕底米白字），
// 同一 page 里 beforeShot 读的 getComputedStyle 却全程浅色真值，内联 #ff0000
// 还原样出红——computed style 不动、paint 被变换、高饱和色豁免，指纹指向
// Chromium 的强制暗色（Auto Dark）。事后无法稳定复现，但这一类"渲染层替页面
// 做主"的来源可以确定性关掉，launch 参数全局带上：
// 定义在同目录 perception-page.js（三个感知工具当时是裸奔的，收成一份）；
// 这里原样再导出，screenshot-url.js 等调用方一站取齐。
export { FIDELITY_LAUNCH_ARGS } from './perception-page.js';

/**
 * 渲染保真探针：主图截完后，往页面塞一块已知色 (#f5f0e4) 的 16px 方块单截，
 * 看栅格出来的像素还认不认账。位图和 computed style 是两条独立感知通道——
 * 渲染层若在做颜色变换，页面内任何 JS 读数都测不到，只有这种"已知输入对
 * 已知输出"的探针测得到。亮度掉一半才报警（抗锯齿/有损压缩的小偏差不算）。
 * 2026-08-05 那次事故 agent 连烧 8 张截图排查自己的 CSS 才怀疑到管线头上——
 * 这个警告就是把那 8 张图省下来的。
 */
export async function detectPaintTransform(page) {
  try {
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = '__nd_paint_probe__';
      d.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;'
        + 'background:#f5f0e4;z-index:2147483647;pointer-events:none';
      document.documentElement.appendChild(d);
    });
    const buf = await page.locator('#__nd_paint_probe__').screenshot({ type: 'png' });
    await page.evaluate(() => document.getElementById('__nd_paint_probe__')?.remove());
    const { default: sharp } = await import('sharp');
    const stats = await sharp(buf).stats();
    const [r, g, b] = stats.channels.map((c) => c.mean);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;   // #f5f0e4 本色 ≈ 239
    if (lum < 128) {
      return '⚠ paint-layer color transform detected: a #f5f0e4 probe rasterized to '
        + `rgb(${r | 0},${g | 0},${b | 0}). This bitmap does NOT faithfully show the page's own colors, `
        + 'and computed styles will keep reporting the authored values — the mismatch is in the '
        + 'rasterizer, not your CSS. Do not debug colors from this shot; report via report_issue '
        + 'and ask the user to eyeball the page in their own browser.';
    }
    return null;
  } catch {
    return null;   // 探针挂了不挡截图
  }
}

/** PNG buffer → { data, mimeType, note }。失败时原样回退 PNG（宁可大也别丢图）。 */
export async function normalizeShot(buf) {
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return { data: buf.toString('base64'), mimeType: 'image/png', note: null };
    const scale = shotScale(w, h);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    let img = sharp(buf);
    if (scale < 1) img = img.resize(tw, th);
    const out = await img.webp({ quality: 82 }).toBuffer();
    let note = scale < 1
      ? `image normalized ${w}x${h} -> ${tw}x${th} webp ${(out.length / 1024).toFixed(0)}KB (vision limit: long edge ${API_LONG_EDGE}px / ~${(API_MAX_PIXELS / 1e6).toFixed(2)}MP; ≈${visionTokens(tw, th)} tokens)`
      : null;
    // 极端长图：整体缩完细节所剩无几，提示换姿势而不是硬看
    if (scale < 0.35 && Math.max(w, h) / Math.min(w, h) > 4) {
      note += ' — long page squeezed hard; details are unreadable at this scale. Prefer sectioned shots (viewport + beforeShot scroll) or pageIndex/device over fullPage.';
    }
    return { data: out.toString('base64'), mimeType: 'image/webp', note };
  } catch (err) {
    return { data: buf.toString('base64'), mimeType: 'image/png', note: `image normalize skipped: ${err?.message || err}` };
  }
}

// ── 页面诊断收集（2026-07-29）──
// 背景：agent 塞了 GSAP/Lenis CDN 却不知道有没有加载成功——截图上看不出来。
// 挂 4 个 playwright listener，截图 caption 里回传 console 错误 + 加载失败资源。
// 上限/截断防止一个疯狂报错的页面把 caption 撑爆。
const DIAG_MAX_ENTRIES = 15;
const DIAG_MAX_TEXT = 300;
const DIAG_MAX_LOGS = 10;   // console:'all' 时 log 级单独一桶，别把真错误挤出去

/**
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {'warn'|'all'} [opts.console] 默认 'warn' 只收 warning/error。
 *   'all' 把 log/info/debug 也带回（单独一桶，capped）。默认档下被滤掉的
 *   log 条数会写进 summary —— agent 上报过：console.log 被静默吞掉，
 *   它以为代码没执行到，白改了两轮（iss_msz24e0q_vfwf）。
 */
export function attachPageDiagnostics(page, opts = {}) {
  const wantAll = opts.console === 'all';
  // ⭐ 聚合按（归一化原因 × 主机）分组，不逐条罗列（agent 上报逮到：一页 30 张
  // 字体请求失败会把 caption 撑成 30 行同一句话，真正独特的那条错误被淹没）。
  // 归一化 = 把消息里的 URL 收成主机名：同一家 CDN 挂 30 个文件是**一个**故障。
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };
  const normText = (t) => t.replace(/https?:\/\/[^\s"')]+/g, (u) => `${hostOf(u)}/…`);

  const consoleEntries = [];      // { type, text, count }，text 是该组第一条原文
  const seenConsole = new Map();  // 归一化文本 → entry
  const noteConsole = (type, rawText) => {
    const text = String(rawText || '').slice(0, DIAG_MAX_TEXT);
    const key = `${type}|${normText(text)}`;
    const prev = seenConsole.get(key);
    if (prev) { prev.count += 1; return; }
    const entry = { type, text, count: 1 };
    seenConsole.set(key, entry);
    if (consoleEntries.length < DIAG_MAX_ENTRIES) consoleEntries.push(entry);
  };

  const failedGroups = new Map();  // `${host}|${detail}` → { method, url, detail, host, count }
  const noteFailed = (method, url, detail) => {
    const key = `${hostOf(url)}|${detail}`;
    const prev = failedGroups.get(key);
    if (prev) { prev.count += 1; return; }
    if (failedGroups.size >= DIAG_MAX_ENTRIES) return;
    failedGroups.set(key, { method, url: url.slice(0, DIAG_MAX_TEXT), detail, host: hostOf(url), count: 1 });
  };

  // log 级单独一桶（'all' 才收），同样按归一化文本分组
  const logEntries = [];
  const seenLogs = new Map();
  let filteredLogs = 0;
  const noteLog = (type, rawText) => {
    const text = String(rawText || '').slice(0, DIAG_MAX_TEXT);
    const key = `${type}|${normText(text)}`;
    const prev = seenLogs.get(key);
    if (prev) { prev.count += 1; return; }
    const entry = { type, text, count: 1 };
    seenLogs.set(key, entry);
    if (logEntries.length < DIAG_MAX_LOGS) logEntries.push(entry);
  };

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') { noteConsole(type, msg.text()); return; }
    if (wantAll) noteLog(type, msg.text());
    else filteredLogs += 1;
  });
  page.on('pageerror', (err) => noteConsole('pageerror', err?.message || err));
  page.on('requestfailed', (req) => noteFailed(req.method(), req.url(), req.failure()?.errorText || 'failed'));
  page.on('response', (res) => {
    if (res.status() < 400) return;
    noteFailed(res.request().method(), res.url(), `HTTP ${res.status()}`);
  });

  return {
    /** 汇成 caption 附加段。干净时给正向确认（"不知道有没有挂"跟"确认没挂"是两回事）。 */
    summary() {
      const failed = [...failedGroups.values()];
      // 被滤掉的 log 条数必须可见 —— "没显示"和"没发生"是两回事
      const filteredNote = filteredLogs > 0
        ? `${filteredLogs} log-level line(s) filtered — pass console:'all' to see them` : null;
      if (!consoleEntries.length && !failed.length && !logEntries.length) {
        return filteredNote
          ? `console clean (${filteredNote}), all requests OK`
          : 'console clean, all requests OK';
      }
      const lines = [];
      if (consoleEntries.length) {
        const total = consoleEntries.reduce((n, e) => n + e.count, 0);
        lines.push(`console (${total}${total > consoleEntries.length ? ` in ${consoleEntries.length} groups` : ''}):`);
        for (const e of consoleEntries) {
          lines.push(`  [${e.type}] ${e.text}${e.count > 1 ? ` (×${e.count} similar)` : ''}`);
        }
      }
      if (logEntries.length) {
        const total = logEntries.reduce((n, e) => n + e.count, 0);
        lines.push(`console logs (${total}${total > logEntries.length ? ` in ${logEntries.length} groups` : ''}):`);
        for (const e of logEntries) {
          lines.push(`  [${e.type}] ${e.text}${e.count > 1 ? ` (×${e.count} similar)` : ''}`);
        }
      }
      if (filteredNote) lines.push(`(${filteredNote})`);
      if (failed.length) {
        const total = failed.reduce((n, f) => n + f.count, 0);
        lines.push(`failed requests (${total}${total > failed.length ? ` in ${failed.length} groups` : ''}):`);
        for (const f of failed) {
          // 每组给一条样本 URL；同主机同原因的其余只报数
          lines.push(`  ${f.method} ${f.url} — ${f.detail}${f.count > 1 ? ` (×${f.count} from ${f.host})` : ''}`);
        }
      }
      return lines.join('\n');
    },
  };
}

/**
 * beforeShot 执行（2026-07-29）：截图环境不滚动 → ScrollTrigger/IO 入场动画永远
 * 不触发 → agent 为"能被截图"反过来阉割设计。给截图前跑一段交互的能力。
 *  - 'scrollToBottom'：分步滚到底再回顶（所有 scroll-linked 动画都触发过一遍）
 *  - 其他字符串：当 JS 片段在页面上下文执行（支持 await），超时兜底
 *
 * 超时 5s→10s（2026-08-19）：重 3D 站 boot 就要 3.5~5 秒，agent 一个会话里
 * 十几次超时还误判功能坏了（iss_msz236jw_9eui）。"等页面就位"这半件事
 * 已经拆给 waitFor 参数（runWaitFor，独立计时），beforeShot 只该剩设置动作。
 */
const BEFORE_SHOT_TIMEOUT_MS = 10000;

/**
 * waitFor：截图前轮询一个页面表达式直到为真（独立 15s 预算，不挤占 beforeShot）。
 * 慢启动页面的正确姿势：waitFor:"window.__game" 等就位，beforeShot 只做设置。
 * 超时不挡截图 —— note 写明没等到，agent 自己判断画面可不可信。
 */
export const WAIT_FOR_TIMEOUT_MS = 15000;
export async function runWaitFor(page, expr) {
  if (!expr) return null;
  try {
    await page.waitForFunction(expr, undefined, { timeout: WAIT_FOR_TIMEOUT_MS, polling: 100 });
    return null;
  } catch (err) {
    const why = /Timeout/i.test(String(err?.message))
      ? `waitFor not truthy within ${WAIT_FOR_TIMEOUT_MS / 1000}s`
      : `waitFor error: ${err?.message || err}`;
    return `${why} (${String(expr).slice(0, 80)}) — captured anyway, the page may not be in the state you expect`;
  }
}

export async function runBeforeShot(page, beforeShot) {
  if (!beforeShot) return null;
  try {
    if (beforeShot === 'scrollToBottom') {
      await page.evaluate(async () => {
        const doc = document.scrollingElement || document.documentElement;
        const step = Math.max(200, window.innerHeight * 0.8);
        for (let y = 0; y <= doc.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, doc.scrollHeight);
        await new Promise((r) => setTimeout(r, 250));
        window.scrollTo(0, 0);
      });
      // 回顶后给 reveal/settle 动画一点时间
      await page.waitForTimeout(400);
    } else {
      await Promise.race([
        page.evaluate(`(async () => { ${beforeShot} })()`),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`beforeShot timeout (${BEFORE_SHOT_TIMEOUT_MS / 1000}s) — if you were waiting for the page to boot, use waitFor instead`)),
          BEFORE_SHOT_TIMEOUT_MS,
        )),
      ]);
      await page.waitForTimeout(200);
    }
    return null;
  } catch (err) {
    // beforeShot 挂了不挡截图 —— 把错误带回 caption 让 agent 知道
    return `beforeShot error: ${err?.message || err}`;
  }
}

/**
 * 带兜底的整页/裁剪截图（iss_mt6tru7p：WebGL 持续动画页 + device:'mobile' 下
 * page.screenshot 等稳定帧/字体 30s 必超时——rAF 每帧都在重绘，"稳定"永远
 * 等不到）。先给 playwright 一次机会（15s，够正常页），超时改走 CDP
 * Page.captureScreenshot：**抓当前帧不等任何东西**。持续动画页抓哪一帧都是
 * 对的——它本来就没有"稳定帧"这回事。
 *
 * @returns {Promise<{buf: Buffer, degraded: boolean}>} degraded=true 走了 CDP 兜底
 */
export async function shotWithFallback(page, opts = {}) {
  try {
    return { buf: await page.screenshot({ ...opts, timeout: 15_000 }), degraded: false };
  } catch (err) {
    if (!/Timeout/i.test(String(err?.message))) throw err;
    const cdp = await page.context().newCDPSession(page);
    try {
      const params = { format: 'png', captureBeyondViewport: !!opts.fullPage };
      // CDP 的 clip：captureBeyondViewport 下是文档坐标，与我们 fullPage+clip 的语义一致
      if (opts.clip) params.clip = { x: opts.clip.x, y: opts.clip.y, width: opts.clip.width, height: opts.clip.height, scale: 1 };
      const { data } = await cdp.send('Page.captureScreenshot', params);
      return { buf: Buffer.from(data, 'base64'), degraded: true };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
}

/**
 * 超长页 fullPage → 滚动位置联络表（iss_mt0365b8）：48000px 的整页压进 API 长边
 * 上限后只剩 47px 宽，什么都看不见——工具自己承认不可读还是把废图塞给了模型。
 * 超过阈值改成：按滚动位置取 5 帧视口，拼一张带位置标注的联络表（跟胶片条同一
 * 套版式，横轴从时间换成滚动位置）。一次调用看清整页节奏；要某段的原尺寸用
 * scrollTo 参数去截那一段。
 */
export const LONG_PAGE_LIMIT = 12_000;

export async function longPageSheet(page, { positions = [0, 0.22, 0.45, 0.68, 0.9] } = {}) {
  const dims = await page.evaluate(() => ({
    docH: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    vpH: window.innerHeight, vpW: window.innerWidth, y0: window.scrollY,
  }));
  if (!(dims.docH > LONG_PAGE_LIMIT)) return null;
  const shots = [];
  for (const p of positions) {
    const y = Math.round(p * (dims.docH - dims.vpH));
    await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
    await page.waitForTimeout(300);   // 给懒加载/reveal 一点点时间，不求全到
    const { buf } = await shotWithFallback(page, { type: 'png' });
    shots.push({ buf, label: `${Math.round(p * 100)}% y=${y}` });
  }
  await page.evaluate((yy) => window.scrollTo(0, yy), dims.y0).catch(() => {});

  const { default: sharp } = await import('sharp');
  const { sheetLayout } = await import('./motion-lab.js');
  const meta = await sharp(shots[0].buf).metadata();
  const L = sheetLayout(shots.length, meta.width, meta.height);
  const composites = []; const labels = [];
  for (let i = 0; i < shots.length; i += 1) {
    const col = i % L.cols; const row = Math.floor(i / L.cols);
    const left = L.gap + col * (L.cellW + L.gap);
    const top = L.gap + row * (L.cellH + L.gap);
    composites.push({ input: await sharp(shots[i].buf).resize(L.cellW, L.cellH, { fit: 'fill' }).png().toBuffer(), left, top });
    labels.push({ left, top, label: shots[i].label });
  }
  const fontH = Math.max(13, Math.round(L.cellH * 0.055));
  const escXml = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${L.sheetW}" height="${L.sheetH}">`,
    ...labels.map((l) => `<rect x="${l.left}" y="${l.top}" width="${(l.label.length * fontH * 0.62 + 12).toFixed(0)}" height="${fontH + 10}" fill="#000" fill-opacity="0.72"/>`
      + `<text x="${l.left + 6}" y="${l.top + fontH + 2}" font-size="${fontH}" fill="#fff" font-family="monospace">${escXml(l.label)}</text>`),
    '</svg>'].join('');
  const buf = await sharp({ create: { width: L.sheetW, height: L.sheetH, channels: 3, background: '#15150f' } })
    .composite([...composites, { input: Buffer.from(svg), left: 0, top: 0 }]).png().toBuffer();
  return {
    buf,
    mode: `long-page contact sheet (doc ${dims.docH}px, ${shots.length} viewports)`,
    note: `整页高 ${dims.docH}px，fullPage 会压成不可读的细条 —— 已改为 ${shots.length} 帧滚动位置联络表（标注=滚动百分比与 y）。要某一段的原尺寸，用 scrollTo 参数（像素/百分比/选择器）单独截那一屏。`,
  };
}

/**
 * fullPage+clip 的"Clipped area is either empty or outside the resulting image"
 * 兜底（iss_mszxp0zy）：Chromium 整页光栅有高度上限（~16384px 纹理），元素落在
 * 超高页更深处时文档坐标 clip 会落到成图之外。兜底=滚到元素处，改用**视口坐标**
 * clip 截当前屏（clip 语义两套：fullPage 下文档坐标 / 非 fullPage 视口坐标，
 * 本机探针 08-19 定过案）。
 */
export async function clipShotWithFallback(page, { clip, selector }) {
  try {
    return await shotWithFallback(page, { fullPage: true, clip, type: 'png' });
  } catch (err) {
    if (!/Clipped area/i.test(String(err?.message)) || !selector) throw err;
    await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const r = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth, vh: window.innerHeight };
    }, selector);
    if (!r) throw err;
    const vClip = {
      x: Math.max(0, r.x), y: Math.max(0, r.y),
      width: Math.max(1, Math.min(r.width, r.vw - Math.max(0, r.x))),
      height: Math.max(1, Math.min(r.height, r.vh - Math.max(0, r.y))),
    };
    const out = await shotWithFallback(page, { clip: vClip, type: 'png' });
    return { ...out, degraded: true };
  }
}
