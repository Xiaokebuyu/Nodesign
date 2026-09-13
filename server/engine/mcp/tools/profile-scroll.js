/**
 * mcp/tools/profile-scroll.js — profile_scroll（2026-08-18）
 *
 * ## 为什么有这个工具
 *
 * 用户说"往下滑动一顿一顿的"，这在设计工具里是最常见的反馈之一。而在这之前
 * 平台给 agent 的全部观测能力是「截一张静态图」—— 帧时、掉帧、图片体积、
 * 长任务一个都看不到。一个 agent 的实际绕路是：起 `python3 -m http.server`
 * → 从仓库 node_modules 直接 import playwright → 手写 rAF 采样器 → 逐项关掉
 * 嫌疑元素做 A/B。它量出来的结论一个都猜不出来：基线 63% 掉帧，单独关视差
 * 64%（没用），单独关全屏胶片颗粒层 40%，两个都关 5% —— 是**叠加效应**，
 * 真凶是「33.7MB 的 PNG + 一个带 mix-blend-mode 的全屏 fixed 层」这对组合。
 * 没有测量，它大概率只会把用户新抱怨的那个功能拆掉交差，剩下 40% 的掉帧
 * 原封不动留在站里。
 *
 * ## 数字怎么读
 *
 * ⚠️ 这台机器 1 vCPU，而且截图 worker 跟 server 抢同一颗核。**绝对值不代表
 * 用户设备上的体验**，它的用处是 A/B：改一处、再量一次、看方向。返回文本里
 * 会重复这句话，别让 agent 拿绝对数字去跟用户汇报。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveCanvasTarget, CANVAS_PATH_DESC, requireBrowsable } from '../../../lib/artifact-target.js';
import { openArtifactPage, launchPerceptionBrowser, degradedNote } from './helpers/perception-page.js';
import { gatedBrowser } from './helpers/browser-slots.js';

const DEVICE_W = { desktop: 1440, tablet: 834, mobile: 390 };
const DEVICE_H = { desktop: 900, tablet: 1112, mobile: 844 };

/**
 * 页面里跑的采样器：**只测量，不自己滚**。
 *
 * ⛔ 前两版都是页面自己 `window.scrollBy` 推进的，两次都测错，原因不同：
 *   v1「大跨步 + 每步 sleep」——合成器在步与步之间有空闲，坏页面照样报 3% 掉帧。
 *   v2「rAF 里逐帧小步推」——压力对了，但**滚动方式还是假的**：程序化滚动
 *      不派发 wheel 事件，于是一整类最常见的"一顿一顿"完全隐形：
 *      wheel handler 里做视差、滚动劫持（scrolljacking）、平滑滚库
 *      （Locomotive/Lenis 那种自己接管滚动的）。用户的手指走的是 wheel 那条路。
 *      而且 `scroll-behavior: smooth` 会把程序化滚动变成动画，实测让量测范围
 *      悄悄缩到 3.5% —— 看着"滚完了"，其实几乎没动。
 * 现在：滚动由外面用 CDP 派发**真 wheel 事件**（≈60Hz），这里只逐帧记 rAF 间隔。
 *
 * ⭐ 顺带白拿一个诊断：派发了多少像素 vs 页面实际走了多少像素。差得远
 *    = 滚动被劫持了，这本身就是答案。
 */
/* eslint-disable no-undef */
function installSampler() {
  const st = {
    frames: [], longTasks: [], po: null, raf: 0, running: true,
    startedAt: performance.now(), last: performance.now(),
    container: null, startTop: 0,
  };
  window.__ndProf = st;
  try {
    st.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) st.longTasks.push(e.duration); });
    st.po.observe({ entryTypes: ['longtask'] });
  } catch { /* 不支持就没有长任务数据 */ }

  // 滚的可能不是 window：应用式版面常常是某个内层容器在滚。wheel 事件落在
  // 指针下面那个元素上，所以内层容器**会**滚 —— 但 window.scrollY 不动，
  // 按它判断就会误报"这页滚不动"。先认出真正在滚的那个。
  const pickContainer = () => {
    const cx = Math.floor(window.innerWidth / 2);
    const cy = Math.floor(window.innerHeight / 2);
    let el = document.elementFromPoint(cx, cy);
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      const scrollable = /(auto|scroll|overlay)/.test(`${cs.overflowY}`) && el.scrollHeight > el.clientHeight + 4;
      if (scrollable) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  st.container = pickContainer();
  st.startTop = st.container.scrollTop;

  const tick = () => {
    if (!st.running) return;
    const now = performance.now();
    st.frames.push(now - st.last);
    st.last = now;
    st.raf = requestAnimationFrame(tick);
  };
  st.raf = requestAnimationFrame(tick);
  return {
    scrollHeight: st.container.scrollHeight,
    clientHeight: st.container.clientHeight,
    isWindow: st.container === (document.scrollingElement || document.documentElement),
  };
}

function collectSampler() {
  const st = window.__ndProf;
  if (!st) return null;
  st.running = false;
  cancelAnimationFrame(st.raf);
  try { st.po?.disconnect(); } catch { /* */ }

  const imgs = performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'img' || /\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/i.test(e.name))
    .map(e => ({
      name: decodeURIComponent(e.name.split('?')[0].split('/').pop() || '').slice(0, 60),
      // encodedBodySize 是**这次传输**的字节；transferSize 命中缓存时是 0。
      // 感知通道现在带 X-ND-Raw，拿的是磁盘原图，所以这个数字就是交付站点的数字。
      bytes: e.encodedBodySize || e.transferSize || 0,
    }));
  imgs.sort((a, b) => b.bytes - a.bytes);

  return {
    frames: st.frames.slice(2),                    // 头两帧含启动抖动
    longTasks: st.longTasks,
    elapsedMs: performance.now() - st.startedAt,
    scrollHeight: st.container.scrollHeight,
    clientHeight: st.container.clientHeight,
    movedPx: st.container.scrollTop - st.startTop,
    imgCount: imgs.length,
    imgBytes: imgs.reduce((a, b) => a + b.bytes, 0),
    topImgs: imgs.slice(0, 5),
    layers: (() => {
      // 「合成层嫌疑」：全屏定位 + 带混合模式/滤镜/半透明的那些，
      // 就是那个真实案例里的另一半凶手
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        const big = r.width * r.height > window.innerWidth * window.innerHeight * 0.5;
        const heavy = cs.mixBlendMode !== 'normal' || cs.filter !== 'none'
          || cs.backdropFilter !== 'none' || (cs.opacity !== '1' && cs.opacity !== '');
        if (big && heavy) {
          const id = el.id ? `#${el.id}` : (typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase());
          out.push(`${id} [${cs.position}, blend=${cs.mixBlendMode}, filter=${cs.filter === 'none' ? '-' : 'yes'}, backdrop=${cs.backdropFilter === 'none' ? '-' : 'yes'}, opacity=${cs.opacity}]`);
        }
        if (out.length >= 5) break;
      }
      return out;
    })(),
  };
}
/* eslint-enable no-undef */

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const kb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`);

export function makeProfileScrollTool({ workspaceRoot, projectId, sessionId }) {
  return tool(
    'profile_scroll',
    `Measure how a page actually performs while scrolling. Loads it over http
(same origin as the user preview), scrolls programmatically, and returns frame
timing, dropped-frame ratio, long tasks, total image bytes and the heaviest
images, plus any full-screen fixed/sticky layers with blend modes or filters.

Scrolling is driven by REAL wheel events, so this also catches the other common
cause of "one frame at a time": the page eating the wheel and scrolling itself
(scroll hijacking, Lenis/Locomotive-style smooth scroll). The report says how
many pixels were dispatched vs how many the page actually moved — if those
disagree, that is your answer and frame times are beside the point.

Use this the moment a user says scrolling feels heavy, janky, laggy or "one
frame at a time" — do NOT start deleting features to guess which one it is.
The one real case on record: baseline 63% dropped frames; killing the parallax
alone changed nothing (64%); killing the full-screen grain layer alone got it to
40%; killing both got 5%; hiding images got 3%. It was an additive effect
between 33.7MB of PNGs and one blended full-screen layer. Guessing would have
removed the wrong thing and left most of the jank in place.

Also worth running before you hand over any image-heavy page: total image bytes
is the single most common cause, and generate_image now writes a .webp sibling
next to every PNG for exactly this reason.

⚠️ This machine has 1 vCPU and the browser competes with the server for it. The
absolute numbers are NOT what the user's device will see. Use them for A/B:
measure, change one thing, measure again, compare direction. Never report the
raw percentage to the user as if it were their experience.`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
      device: z.enum(['desktop', 'tablet', 'mobile']).optional()
        .describe('Viewport preset (default desktop 1440×900). Mobile is where jank shows up worst.'),
      frames: z.number().int().min(30).max(300).optional()
        .describe('How many wheel steps to scroll across (default 120 ≈ a 2-second scroll at 60Hz). Real wheel events are dispatched at ~60Hz, the same rate a trackpad fires — so wheel handlers, scroll hijacking and smooth-scroll libraries are all in the measurement.'),
    },
    async ({ path: relPath, device, frames: framesArg }) => {
      const asText = (text) => ({ content: [{ type: 'text', text }] });
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target) return { content: [{ type: 'text', text: 'No page found to profile.' }], isError: true };
      const guard = requireBrowsable(target);
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

      const dev = device || 'desktop';
      const viewport = { width: DEVICE_W[dev], height: DEVICE_H[dev] };
      const nFrames = framesArg ?? 120;

      let browser;
      try {
        // 量帧时间：独占全部浏览器槽位，别的 chromium 同时在跑量出来的卡顿是假的（browser-slots.js）
        browser = await gatedBrowser(() => launchPerceptionBrowser(), { exclusive: true });
        const opened = await openArtifactPage(browser, {
          projectId, workspaceRoot, absPath: target.absPath, viewport,
        });
        await opened.goto();
        const page = opened.page;

        // 采样器先装上（它顺手认出真正在滚的那个容器），再从外面派发真 wheel
        const geom = await page.evaluate(installSampler);
        const scrollable = Math.max(0, geom.scrollHeight - geom.clientHeight);
        // 每帧推进量：把可滚范围在 nFrames 帧里走完。下限 6px —— 太小的话短页面
        // 一直停在原地，样本全是静止帧（那种"满分"没有意义）。
        const perFrame = Math.max(6, Math.round(scrollable / nFrames));

        // ⭐ 真 wheel，配速 ≈60Hz。配速是必要的：不配速的话 CDP 一秒能塞几百个
        // wheel，任何页面都会显得卡（假警报），而真人的滚轮/触摸板就是 60-120Hz。
        await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
        const t0 = Date.now();
        for (let i = 0; i < nFrames; i += 1) {
          await page.mouse.wheel(0, perFrame);
          const wait = (t0 + (i + 1) * 16) - Date.now();
          if (wait > 1) await page.waitForTimeout(wait);
        }
        await page.waitForTimeout(120);   // 让最后几帧和长任务落账
        const r = await page.evaluate(collectSampler);

        // ⛔ **不再过滤长帧**。原来是 `frames.filter(f => f > 0 && f < 2000)`，
        // 于是一个 3017ms 的冻结**被当成脏数据剔掉**，剩下的帧算出 `dropped 0%`
        // 且不作任何提示 —— 越卡越可能被删。A/B 甚至会反过来（把页面改得更卡
        // 反而报得更好）。长帧正是要找的东西。
        const frames = r.frames.filter(f => f > 0);
        const dropped = frames.filter(f => f > 16.7 * 1.5).length;
        const dropRatio = frames.length ? (dropped / frames.length) * 100 : 0;
        const worst = frames.length ? Math.max(...frames) : 0;
        const freezes = frames.filter(f => f > 250).length;
        // 派发了多少 vs 真走了多少。差很多 = 滚动被劫持/被平滑滚库接管，
        // 这本身就是"一顿一顿"的答案，不必再往下猜。
        const askedPx = perFrame * nFrames;
        const movedPx = Math.round(r.movedPx);
        const followRatio = askedPx ? (movedPx / askedPx) * 100 : 100;
        // 样本不足就说不足。原来这种情况报的是 `p50 0.0ms / dropped 0%` ——
        // 一句"满分"，而真相是**什么都没量到**（溢出面板、短页、滚不动的页）。
        const tooFew = frames.length < 20;
        // 判据是**跟随率**不是绝对位移：实测那个劫持页走了 960px（不算"没动"），
        // 但只跟上了派发量的 13% —— 用户手上的感觉就是"滚了半天没动"。
        // 60% 是留给平滑滚库正常惯性的余量。
        const hijacked = askedPx > 400 && followRatio < 60;

        // 契约：note 非空必须写进返回文本。这个工具尤其不能漏 —— 它的描述铁口
        // 直断"走 http 同源"，退回 file:// 后它按 Resource Timing 报的
        // 「images 0 files 0KB」正好是它主诊断的反面。
        const degraded = degradedNote(opened);
        const lines = [
          ...(degraded ? [degraded, ''] : []),
          `profile_scroll — ${target.relPath} @ ${dev} ${viewport.width}×${viewport.height}`,
          `scroll container ${geom.isWindow ? 'window' : 'an inner element (overflow:auto)'}`
            + `, scrollable ${scrollable}px, real wheel events ${perFrame}px × ${nFrames} @60Hz`,
          `moved ${movedPx}px of ${askedPx}px dispatched (${followRatio.toFixed(0)}% followed)`,
          '',
          ...(tooFew ? [
            `⚠ ONLY ${frames.length} frames sampled — that is not enough to say anything.`,
            '  Nothing below is a verdict. Usual causes: the page is barely taller than the',
            '  viewport, or the thing that scrolls is not under the centre of the screen.',
            '',
          ] : []),
          ...(hijacked ? [
            `⚠ ${nFrames} real wheel events asked for ${askedPx}px; the page moved ${movedPx}px (${followRatio.toFixed(0)}%).`,
            '  Something is EATING the scroll — a wheel handler doing custom scrolling,',
            '  scroll hijacking, or a smooth-scroll library (Lenis/Locomotive). That IS the',
            '  jank the user feels: their wheel and the page no longer agree. Look at wheel',
            '  listeners before you look at images or layers.',
            '',
          ] : []),
          `frame time  p50 ${pct(frames, 50).toFixed(1)}ms  p90 ${pct(frames, 90).toFixed(1)}ms  p99 ${pct(frames, 99).toFixed(1)}ms  (16.7ms = 60fps)`,
          `dropped     ${dropRatio.toFixed(0)}% of ${frames.length} frames took >25ms`,
          `worst frame ${worst.toFixed(0)}ms${freezes ? `  ·  ${freezes} frame(s) over 250ms = a visible freeze` : ''}`,
          `long tasks  ${r.longTasks.length}${r.longTasks.length ? ` (worst ${Math.max(...r.longTasks).toFixed(0)}ms)` : ''}`,
          '',
          `images      ${r.imgCount} files, ${kb(r.imgBytes)} total (as delivered: originals, not preview variants)`,
          ...(r.topImgs.length
            ? [`heaviest    ${r.topImgs.map(i => `${i.name} ${kb(i.bytes)}`).join('  ·  ')}`]
            : []),
          ...(r.layers.length
            ? ['', 'full-screen composited layers (a classic other half of the problem):',
              ...r.layers.map(l => `  ${l}`)]
            : []),
          '',
          r.imgBytes > 5 * 1024 * 1024
            ? `⚠ ${kb(r.imgBytes)} of images is the first thing to fix — reference the .webp siblings instead of the PNG masters.`
            : null,
          dropRatio > 25 && r.layers.length
            ? '⚠ Both heavy layers and dropped frames present. These are usually ADDITIVE — test removing them one at a time AND together before concluding.'
            : null,
          '',
          'Numbers are for A/B comparison on this 1-vCPU box, not the user\'s device.',
        ].filter(l => l !== null);
        return asText(lines.join('\n'));
      } catch (err) {
        return { content: [{ type: 'text', text: `profile_scroll failed: ${err?.message || String(err)}` }], isError: true };
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  );
}
