/**
 * mcp/tools/screenshot.js — screenshot_canvas：产物的眼睛（站点页 / deck / docx 页图）
 *
 * 页面从 helpers/acquire-page.js 拿（一次性可复现；live:true 对着产物会话页）；
 * 静帧 / 裁元素 / 整页 / 设备宽 / waitFor / beforeShot / scrollTo 在这里；
 * 胶片条（frames + trigger/click/scrollBy + 元素探针）的录制器是 helpers/motion-lab.js
 * + helpers/motion-scroll.js，跟浏览通道的 browser_screenshot 共用一份。
 * 归一化 / 诊断 / 保真探针在 helpers/shot-pipeline.js。docx 走 screenshot-docx.js。
 * 描述与入参 schema、参数组合合同在 screenshot-schema.js；probe（页面求值带回文字）在 helpers/shot-probe.js，
 * docx 页图落盘（saveTo）在 helpers/save-shots.js（09-17）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { resolveDeckSize, extractDeckAspect } from '../../../shared/deck.js';
import { resolveCanvasTarget, KIND_SITE, requireBrowsable } from '../../../lib/artifact-target.js';
import { can } from '../../../lib/kinds/index.js';
import { screenshotDocx } from './screenshot-docx.js';
import { SITE_DEVICE_W } from './helpers/perception-page.js';
import { acquireArtifactPage } from './helpers/acquire-page.js';
import { SCREENSHOT_CANVAS_DESCRIPTION, SCREENSHOT_CANVAS_SCHEMA, argConflict } from './screenshot-schema.js';
import { runProbe, probeLines, probeOnlyText } from './helpers/shot-probe.js';
import { normalizeShot, detectPaintTransform, runWaitFor, runBeforeShot, shotWithFallback, longPageSheet, clipShotWithFallback } from './helpers/shot-pipeline.js';
import { recordMotion, pickNearestFrames, composeSheet, encodeWebm, motionCaptionLines } from './helpers/motion-lab.js';
import { wheelScroll, elementMotionReport, elementMotionLines } from './helpers/motion-scroll.js';

// 截图光栅倍率：布局按 deck 逻辑尺寸，位图按这个倍率出（vision token 按像素计费）
const RASTER_SCALE = 0.6;


/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */

export function makeScreenshotCanvasTool({ workspaceRoot, projectId, sessionId, ctx }) {
  return tool(
    'screenshot_canvas',
    SCREENSHOT_CANVAS_DESCRIPTION,
    SCREENSHOT_CANVAS_SCHEMA,
    async ({ viewport, fullPage, selector, pageIndex, detail, device, waitFor, beforeShot, pages, scrollTo, settleMs, console: consoleLevel, frames, trigger, click, saveVideo, scrollBy, elements, probe, shot: wantShot, saveTo, path: relPath, live }) => {
      // 任务模型（2026-07-28）：deck 住 tasks/<任务>/canvas.html。寻址统一走
      // canvas-target（显式 path → 本会话当前 deck → cwd/canvas.html → 唯一任务 deck）
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };
      // 形态分流按**能力位**不按形态名：能渲染的（docx）走 LibreOffice 页图管线，
      // 能浏览的（deck / site）继续往下走 playwright。加第四种形态时改注册表不改这里。
      // probe / shot / saveTo 跟形态、胶片条的组合不静默忽略：不适用就拒并说明（09-17）
      const docx = can(target.kind, 'renderable');
      const conflict = argConflict(docx ? 'docx' : 'page', { probe, shot: wantShot, saveTo, frames });
      if (conflict) return { content: [{ type: 'text', text: conflict }], isError: true };
      if (docx) return screenshotDocx(target, { pages, detail, saveTo, shot: wantShot, workspaceRoot, projectId, ctx });
      const notBrowsable = requireBrowsable(target);
      if (notBrowsable) return { content: [{ type: 'text', text: notBrowsable }], isError: true };
      const canvasPath = target.absPath;
      let html;
      try {
        html = await fs.readFile(canvasPath, 'utf8');
      } catch {
        return {
          content: [{ type: 'text', text: `${target.relPath} not found. Write it first before screenshotting.` }],
          isError: true,
        };
      }

      const isSite = target.kind === KIND_SITE;

      // 站点没有"比例"这回事：版面是被视口宽度算出来的，所以档位给的是真实设备
      // 宽度，直接当 viewport 用、不缩放。拿 deck 那套 1920×1080 去截站点，会得到
      // 一张"看起来还行"但跟任何真实设备都对不上的图 —— 断点有没有生效看不出来。
      const vp = viewport
        || (isSite
          ? { width: SITE_DEVICE_W[device || 'desktop'], height: 900 }
          : (() => { const d = resolveDeckSize(extractDeckAspect(html)); return { width: d.width, height: d.height }; })());

      if (isSite && pageIndex) {
        return {
          content: [{
            type: 'text',
            text: `${target.relPath} 是站点页面，没有 <section data-page="N"> 分页。`
              + '站点的"页"是独立文件：用 path 指定要截哪个页面（先 list_pages 看清单），'
              + '用 device 切换 desktop / tablet / mobile 检查断点。',
          }],
          isError: true,
        };
      }

      // 默认 false：fullPage 截图体积是 viewport 的 N× (N=页数)，且会留在 context
      // 多 turn 直到 autoCompact。agent 不显式传就走 viewport 单屏（cheapest），
      // 真要 deck-wide overview 显式 fullPage:true 或派 vision-checker。
      // 站点相反：默认整页 —— 网页本来就是长的，只截首屏等于没看过下面那些。
      // scrollTo 与 fullPage 互斥：前者的语义就是"真的滚，按视口抓"
      const fp = scrollTo != null ? false : (fullPage !== undefined ? fullPage === true : isSite);

      let acq;
      try {
        // 位图缩放（2026-07-28 上下文瘦身，08-21 按新视觉档重算）：布局仍按 deck 逻辑
        // 尺寸排（1920 宽），光栅按 RASTER_SCALE 出图。高分辨率档 token = ⌈w/28⌉×⌈h/28⌉：
        // 1920×1080 全幅 2691 token，×0.6 = 1152×648 → 1008 token，排版检查完全够看。
        // 要读小字（版权行 / 数据标签）显式传 detail:'high' 走 1.0（现在真的是 1920×1080，
        // 旧档会先缩到 1568）。
        const rasterScale = detail === 'high' ? 1 : RASTER_SCALE;
        // ⭐ 页面从统一口拿（helpers/acquire-page.js）：live:true = 产物会话里现在这一页
        // （状态保留、用完只松锁）；否则新开一只保真 chromium 走 http（跟用户预览同一条
        // artifact-file 通道、同源），用完关 —— "截图必须可复现"的契约不破。
        acq = await acquireArtifactPage({
          projectId, workspaceRoot, target, live,
          viewport: vp, deviceScaleFactor: rasterScale,
          // 胶片条量真实帧间距：独占全部浏览器槽位（helpers/browser-slots.js）
          exclusive: Array.isArray(frames) && frames.length > 0,
          diagnostics: { console: consoleLevel },   // 由出口在 goto 之前挂（09-17 iss_mt886uc1_7rne：拿到页面再挂，加载期失败全漏）
        });
        const page = acq.page;
        const opened = acq;   // degradedNote / viaHttp 的口径不变
        // live 页的视口是会话的，不是本次参数的 —— 下面所有按 vp 算的东西都得按真视口
        if (acq.live) { vp.width = acq.viewport.width; vp.height = acq.viewport.height; }
        const diag = acq.diag;
        let gotoNote = [opened.note, acq.gotoNote, acq.liveNote].filter(Boolean).join(' | ') || null;

        // 三段各自计时（waitFor / beforeShot / settle），caption 报用时 ——
        // agent 之前分不清 5 秒预算被哪一段吃掉，只能碰运气重截
        const timing = [];
        let waitForNote = null;
        if (waitFor) {
          const t0 = Date.now();
          waitForNote = await runWaitFor(page, waitFor);
          timing.push(`waitFor ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
        let beforeShotNote = null;
        if (beforeShot) {
          const t0 = Date.now();
          beforeShotNote = await runBeforeShot(page, beforeShot);
          timing.push(`beforeShot ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }

        // ── scrollTo：真滚视口（2026-08-18）──
        //
        // fullPage 走的是 captureBeyondViewport：视口被撑成整页高，`innerHeight`
        // 从头到尾不变。所以页面里一切"按滚动位置判断"的逻辑（IntersectionObserver
        // reveal、scroll-snap、视差、sticky）在 fullPage 下的行为跟用户看到的不是
        // 一回事 —— 有 agent 因此反复改页面代码去迁就截图环境，而那些代码在真实
        // 浏览器里从第一版起就是对的。这条路是"真的滚，然后按视口抓一帧"。
        let scrollNote = null;
        if (scrollTo != null) {
          try {
            const landed = await page.evaluate(async (spec) => {
              const doc = document.documentElement;
              const maxY = Math.max(0, doc.scrollHeight - window.innerHeight);
              let y = null;
              if (typeof spec === 'number') y = spec;
              else if (/^-?[\d.]+%$/.test(spec)) y = maxY * (parseFloat(spec) / 100);
              else {
                const el = document.querySelector(spec);
                if (!el) return { error: `scrollTo selector matched nothing: ${spec}` };
                y = el.getBoundingClientRect().top + window.scrollY;
              }
              window.scrollTo({ top: Math.max(0, Math.min(y, maxY)), behavior: 'instant' });
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
              return { y: window.scrollY, maxY, innerHeight: window.innerHeight };
            }, scrollTo);
            if (landed?.error) scrollNote = landed.error;
            else {
              await page.waitForTimeout(settleMs ?? 350);
              scrollNote = `scrolled to y=${Math.round(landed.y)} of ${Math.round(landed.maxY)}`
                + ` (viewport ${landed.innerHeight}px tall, real scroll — reveal/snap/parallax behave as they do for the user)`;
            }
          } catch (err) {
            scrollNote = `scrollTo failed: ${err.message}`;
          }
        }

        // ── probe（09-17，iss_mtvtvqs2_0ad4）：waitFor / beforeShot / scrollTo+settle 之后、截图之前求值，
        // 读到的就是截图那一刻的状态。胶片条没有「那一刻」，在录制结束后跑（见下）。shot:false 到此为止，只回文字
        const filming = Array.isArray(frames) && frames.length > 0;
        let probeRes = null;
        if (probe && !filming) {
          probeRes = await runProbe(page, probe);
          timing.push(`probe ${(probeRes.ms / 1000).toFixed(1)}s`);
        }
        if (wantShot === false) {
          const notes = [opened.viaHttp ? 'Loaded over http, same origin as the user preview.' : null,
            gotoNote, scrollNote, waitForNote, beforeShotNote];
          return { content: [{ type: 'text', text: probeOnlyText({ relPath: target.relPath, viewport: vp, live: acq.live, probeRes, notes, timing, diagSummary: diag.summary() }) }] };
        }

        // ── 胶片条（2026-08-19，iss_mszv782a_toab）──
        // 动画的好坏在时间轴上，静帧看不见缓动/过冲/硬切。CDP screencast 录一段
        // （渲染进程每次重绘推一帧、帧带 epoch 时间戳 —— page.screenshot 连拍一张
        // 100~300ms，压不进 120ms 帧距），按请求时刻取最近帧，拼一张 contact sheet。
        if (filming) {
          const wanted = [...frames].sort((a, b) => a - b);
          const durationMs = Math.max(300, Math.round(Math.max(...wanted)));

          // selector / pageIndex → 每格裁到该元素（视口坐标；录制不滚动，元素得在视口里）
          let crop = null;
          let cropNote = null;
          const cropSelector = selector || (pageIndex ? `section[data-page="${pageIndex}"]` : null);
          if (cropSelector) {
            const r = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) return { error: 'none' };
              const b = el.getBoundingClientRect();
              return { x: b.left, y: b.top, w: b.width, h: b.height, vw: window.innerWidth, vh: window.innerHeight };
            }, cropSelector);
            if (r.error) {
              return { content: [{ type: 'text', text: `Selector matched no elements: ${cropSelector}` }], isError: true };
            }
            const ix = Math.max(0, r.x); const iy = Math.max(0, r.y);
            const iw = Math.min(r.x + r.w, r.vw) - ix; const ih = Math.min(r.y + r.h, r.vh) - iy;
            if (iw > 8 && ih > 8) crop = { x: ix, y: iy, w: iw, h: ih };
            else {
              cropNote = `selector "${cropSelector}" lies outside the viewport — filmstrip records the viewport only, `
                + 'cells show the full viewport (use scrollTo to bring it in first)';
            }
          }

          // 真滚轮驱动 + 元素探针（08-21，跟浏览通道的胶片条同一份 motion-scroll）
          const y0 = await page.evaluate(() => window.scrollY).catch(() => 0);
          const during = scrollBy ? (p) => wheelScroll(p, { px: scrollBy, durationMs: Math.max(200, durationMs - 100) }) : null;
          const rec = await recordMotion(page, {
            durationMs, trigger, click, during, probeElements: elements !== false,
            shotMaxW: Math.max(320, Math.round(vp.width * rasterScale)),
            shotMaxH: Math.max(240, Math.round(vp.height * rasterScale)),
          });
          const y1 = await page.evaluate(() => window.scrollY).catch(() => y0);
          const motion = elements !== false ? elementMotionReport(rec.elems, { scrolledPx: y1 - y0 }) : null;
          const endProbe = probe ? await runProbe(page, probe) : null;   // 录制结束时的状态（09-17）
          if (rec.shots.length === 0) {
            return {
              content: [{
                type: 'text',
                text: [
                  'Filmstrip failed: the screencast captured zero frames — the page never painted during the window.',
                  rec.clickNote, rec.triggerNote, diag.summary(),
                ].filter(Boolean).join('\n'),
              }],
              isError: true,
            };
          }

          const picked = pickNearestFrames(rec.shots, wanted);
          const sheet = await composeSheet(picked, { crop, cropRefW: vp.width });

          let videoNote = null;
          if (saveVideo) {
            try {
              const base = path.basename(canvasPath, path.extname(canvasPath));
              // 带毫秒：09-13 起截图可以并行，同一页同一秒录两段会互相覆盖
              const rel = `exports/motion/${base}-${new Date().toISOString().slice(11, 23).replace(/[:.]/g, '')}.webm`;
              const { bytes } = await encodeWebm(rec.shots, path.join(workspaceRoot, rel));
              videoNote = `video saved: ${rel} (${(bytes / 1024).toFixed(0)}KB, real frame timing — jank preserved) — deliver_files to hand it to the user`;
            } catch (err) {
              videoNote = `video encode failed: ${err?.message || err}`;
            }
          }

          try {
            ctx?.emit?.({ type: 'run.screenshot_taken', sizeBytes: sheet.buf.length, viewport: vp, mode: `filmstrip x${wanted.length}` });
          } catch { /* emit fail-safe */ }

          const shot = await normalizeShot(sheet.buf);
          const cells = picked
            .map((p, i) => (p ? `#${i + 1} t=${Math.round(p.want)}ms→${Math.round(p.actual)}ms` : `#${i + 1} (no frame)`))
            .join('  ');
          const cap = [
            `Filmstrip of ${target.relPath} — ${wanted.length} cells, ${sheet.layout.cols}x${sheet.layout.rows} grid, `
              + `viewport ${vp.width}x${vp.height} (t=0 = the moment click/trigger fired; labels show requested vs captured time)`,
            cells,
            ...(cropNote ? [cropNote] : []),
            ...(endProbe ? probeLines(endProbe).map((l, i) => (i ? l : l.replace(/^probe /, 'probe (after the recording) '))) : []),
            ...(motion ? elementMotionLines(motion) : []),
            ...motionCaptionLines(rec),
            ...(videoNote ? [videoNote] : []),
            ...(gotoNote ? [gotoNote] : []),
            ...(waitForNote ? [waitForNote] : []),
            ...(beforeShotNote ? [beforeShotNote] : []),
            ...(scrollNote ? [scrollNote] : []),
            ...(shot.note ? [shot.note] : []),
            diag.summary(),
          ];
          return {
            content: [
              { type: 'text', text: cap.join('\n') },
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
            ],
          };
        }

        // selector / pageIndex 优先，命中则截元素 bbox（locator.screenshot），
        // 都不给走 fullPage / viewport。新范式所有 section 默认平铺可见
        // （系统 fit script 包 frame + scroll-snap），locator.screenshot 自动
        // 拿目标 section 的 bbox，不需要再操作 DOM。
        let buf;
        let shotDegraded = false;
        let longPageNote = null;
        let captureMode;
        const targetSelector = selector
          || (pageIndex ? `section[data-page="${pageIndex}"]` : null);

        if (targetSelector) {
          // 不走 locator.screenshot：它的 "waiting for element to be stable" 对
          // requestAnimationFrame 持续重绘的元素（WebGL canvas / 无限动画）永远
          // 等不到，白烧 20 秒后必失败（iss_msz24x5h_er8l）。改成读元素的文档
          // 坐标 → fullPage 截图 clip 裁剪：clip 在 fullPage 下是文档坐标、可截
          // 视口外（本机 playwright 探针验证过），既不用滚动也没有 stability 等待。
          const rect = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return { error: 'none' };
            const r = el.getBoundingClientRect();
            const doc = document.documentElement;
            return {
              x: r.left + window.scrollX, y: r.top + window.scrollY,
              width: r.width, height: r.height,
              docW: Math.max(doc.scrollWidth, doc.clientWidth),
              docH: Math.max(doc.scrollHeight, doc.clientHeight),
            };
          }, targetSelector);
          if (rect.error) {
            return {
              content: [{
                type: 'text',
                text: `Selector matched no elements: ${targetSelector}`,
              }],
              isError: true,
            };
          }
          if (rect.width < 1 || rect.height < 1) {
            return {
              content: [{
                type: 'text',
                text: `Selector matched an element with zero size (${rect.width}x${rect.height}): ${targetSelector}`
                  + ' — it is display:none / collapsed, nothing to capture.',
              }],
              isError: true,
            };
          }
          // clip 超出文档边界 playwright 直接报错 —— 夹回文档内
          const clip = {
            x: Math.max(0, rect.x),
            y: Math.max(0, rect.y),
          };
          clip.width = Math.max(1, Math.min(rect.width, rect.docW - clip.x));
          clip.height = Math.max(1, Math.min(rect.height, rect.docH - clip.y));
          ({ buf, degraded: shotDegraded } = await clipShotWithFallback(page, { clip, selector: targetSelector }));
          captureMode = `selector="${targetSelector}"`;
        } else {
          // 超长页 fullPage → 滚动联络表（阈值与理由见 shot-pipeline.longPageSheet）
          const sheet = fp ? await longPageSheet(page).catch(() => null) : null;
          if (sheet) {
            buf = sheet.buf; captureMode = sheet.mode; longPageNote = sheet.note;
          } else {
            ({ buf, degraded: shotDegraded } = await shotWithFallback(page, { fullPage: fp, type: 'png' }));
            captureMode = isSite
              ? `site ${device || 'desktop'} ${vp.width}px, fullPage=${fp}`
              : `fullPage=${fp}`;
          }
        }
        // live 页的 DPR 是会话的（1），detail:'normal' 的 0.6 光栅在这里事后缩
        if (acq.live && rasterScale < 1) {
          const { default: sharp } = await import('sharp');
          const m = await sharp(buf).metadata();
          buf = await sharp(buf).resize({ width: Math.max(1, Math.round((m.width || 1) * rasterScale)) }).png().toBuffer();
        }

        // emit 让前端可见 agent 在自检
        try {
          ctx?.emit?.({
            type: 'run.screenshot_taken',
            sizeBytes: buf.length,
            viewport: vp,
            mode: captureMode,
          });
        } catch { /* emit fail-safe */ }

        // ── fullPage 的 fixed/sticky 诊断（2026-08-18）──
        // fullPage 下视口被撑成整页高，于是 position:fixed 的元素被画在"展开视口"
        // 的对应位置：一个静止时藏在视口下方的转场帘幕（translateY(100%)）会出现
        // 在页面中段，看上去就是一大块盖住内容的色块；sticky 页头会横穿版面。
        // 两个 agent 都把它当成真的布局 bug 去查了 computed style。一行字的事。
        // selector / pageIndex 截的是元素自己的盒子，不涉及展开视口，这条警告是误导（09-17 iss_mtw1ulg7_mi21）
        let fixedNote = null;
        if (fp && !targetSelector) {
          try {
            const found = await page.evaluate(() => {
              const out = [];
              for (const el of document.querySelectorAll('*')) {
                const pos = getComputedStyle(el).position;
                if (pos !== 'fixed' && pos !== 'sticky') continue;
                const r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                const id = el.id ? `#${el.id}` : (el.className && typeof el.className === 'string'
                  ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase());
                out.push(`${id}(${pos})`);
                if (out.length >= 6) break;
              }
              return out;
            });
            if (found.length) {
              fixedNote = `⚠ ${found.length} fixed/sticky element(s) on this page (${found.join(', ')}).`
                + ' In a fullPage shot they are painted at their position within the EXPANDED viewport,'
                + ' not where the user sees them — a full-screen overlay parked below the fold will appear'
                + ' mid-page and look like it covers the content. Do not debug layout from that;'
                + ' use scrollTo to see their real position. A full-screen modal / sheet does not move with'
                + ' scrolling — capture it with selector (its own box) instead.';
            }
          } catch { /* 诊断挂了不挡截图 */ }
        }

        const paintNote = await detectPaintTransform(page);
        const shot = await normalizeShot(buf);

        const captionParts = [
          `Screenshot of ${target.relPath} (layout ${vp.width}x${vp.height} @${rasterScale}x raster, ${captureMode})`
          + (shotDegraded ? '（常规截图等稳定帧超时——页面在持续动画（WebGL/rAF），已改抓当前帧：画面是真实的某一瞬间，动画中间态属正常）' : '')
          + (longPageNote ? `（${longPageNote}）` : ''),
          ...probeLines(probeRes),
        ];
        // 加载通道写进 caption：agent 不用再靠"把 location.protocol 写进 DOM 再截一张"
        // 去反推自己被什么方式打开了（问题库 iss_msxk2oci_0v0v 就是这么查了四轮）
        if (opened.viaHttp) {
          captionParts.push('Loaded over http, same origin as the user preview — fetch/XHR, localStorage and dynamic imports behave exactly as they do for the user.');
        }
        if (shot.note) captionParts.push(shot.note);
        if (gotoNote) captionParts.push(gotoNote);
        if (scrollNote) captionParts.push(scrollNote);
        if (waitForNote) captionParts.push(waitForNote);
        if (beforeShotNote) captionParts.push(beforeShotNote);
        if (timing.length) captionParts.push(`timing: ${timing.join(' · ')}`);
        if (fixedNote) captionParts.push(fixedNote);
        if (paintNote) captionParts.push(paintNote);
        captionParts.push(diag.summary());

        return {
          content: [
            {
              type: 'text',
              text: captionParts.join('\n'),
            },
            {
              type: 'image',
              data: shot.data,
              mimeType: shot.mimeType,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Screenshot failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      } finally {
        await acq?.release?.();   // 一次性：关浏览器；live：松会话锁
      }
    },
  );
}
