/**
 * mcp/tools/browse-screenshot.js — browser_screenshot：参考站的静帧 + 胶片条（2026-08-21 从 browse.js 搬出）
 *
 * 静帧那半照旧（视口 / 整页 / 裁元素 / 先滚到某处）。新的是**时间维度**：
 * `frames` + `trigger` / `click` / `scrollBy` → 一张按时刻拼好的 contact sheet，
 * 外加元素探针（谁在动、怎么动）。录制器就是感知通道胶片条那份 motion-lab，
 * 不抄第二份；滚动驱动走 motion-scroll 的真滚轮（滚动劫持那族只认真输入）。
 *
 * 参考站看动效的两层里这是第二层"动起来长什么样"；第一层"靠什么在动"是
 * browser_capture 的 motion 档（engine/motion/inventory.js）。
 */

import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withBrowser, _limits } from '../../browse/registry.js';
import { saveFrame } from '../../browse/state.js';
import { normalizeShot, visionTokens } from './helpers/shot-pipeline.js';
import { recordMotion, pickNearestFrames, composeSheet, encodeWebm, motionCaptionLines } from './helpers/motion-lab.js';
import { wheelScroll, elementMotionReport, elementMotionLines } from './helpers/motion-scroll.js';

const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function where(page) {
  const [title, url] = await Promise.all([page.title().catch(() => ''), Promise.resolve(page.url())]);
  return `${title || '(无标题)'} — ${url}`;
}

async function scrollViewportTo(page, spec) {
  await page.evaluate(async (s) => {
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    let y = 0;
    if (typeof s === 'number') y = s;
    else if (/^-?[\d.]+%$/.test(s)) y = maxY * (parseFloat(s) / 100);
    else { const el = document.querySelector(s); if (el) y = el.getBoundingClientRect().top + window.scrollY; }
    window.scrollTo({ top: Math.max(0, Math.min(y, maxY)), behavior: 'instant' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, spec);
  await page.waitForTimeout(350);
}

export function makeBrowserScreenshotTool({ projectId, workspaceRoot }) {
  const VP = _limits.VIEWPORT;
  return tool(
    'browser_screenshot',
    `Screenshot the current page in the browser session.

This is what makes browsing useful for design work: read tells you what a page
says, this tells you what it looks like — the layout rhythm, how the type is
set, where the whitespace is, how an opening screen is composed.

Default is the viewport (${VP.width}×${VP.height}, cheap; its pixels are the coordinate
space browser_computer uses, 1:1). fullPage for the whole scroll, or a selector
for one component you want to look at closely. For a magnified look at a small
region use browser_computer zoom.

FILMSTRIP — the eye for the site's MOTION. A still cannot show how a hero
reveals, how cards stagger in, how parallax layers slide, whether scrolling is
hijacked into a smooth-scroll. Pass frames (2-30 ms offsets, e.g. [0,150,300,600,1000]
for one move, 12-30 spread over a long scroll) and
ONE of: scrollBy (px of REAL wheel scrolling spread over the recording — use
this for scroll-driven motion, it is what a visitor does), trigger (JS that
starts a move), or click (a CSS selector, a real trusted click). You get ONE
contact sheet of the viewport at those moments, plus an ELEMENT PROBE: which
elements moved/faded/scaled during the recording, by how much, and when —
parallax vs entrance vs fixed are told apart. Pair it with
browser_capture{kinds:['motion']} which tells you WHAT the site uses
(keyframes, transitions, scroll-timeline, GSAP/ScrollTrigger, reveal classes);
this tells you how it looks and feels. saveVideo:true also writes a .webm into
the workspace for the user.`,
    {
      fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport. Several times more expensive.'),
      selector: z.string().optional().describe('Capture only the first element matching this CSS selector.'),
      scrollTo: z.union([z.number(), z.string()]).optional()
        .describe("Scroll the viewport here first: pixels, a percentage like '50%', or a CSS selector. Real scroll, so entry animations and sticky headers behave as a visitor sees them."),
      frames: z.array(z.number().min(0).max(15000)).min(2).max(30).optional()
        .describe('FILMSTRIP: capture the viewport at these ms offsets (t=0 = when scrollBy/trigger/click starts) and return one timestamped contact sheet. 2-30 offsets; the sheet has a fixed pixel budget (~2.3MP, ≈3-3.7k tokens), so more cells = smaller cells — 6-10 to read detail, 12-16 for a whole sequence, 20-30 for long scroll choreographies where rhythm matters more than detail (zoom a cell region afterwards). Place them where the motion lives; include 0.'),
      scrollBy: z.number().min(-8000).max(8000).optional()
        .describe('FILMSTRIP: pixels of real wheel scrolling dispatched over the recording window (positive = down). The natural way to record scroll-driven motion on a site you did not write.'),
      trigger: z.string().optional().describe('FILMSTRIP: JS evaluated in page context at t=0 to start a move (await OK).'),
      click: z.string().optional().describe('FILMSTRIP: CSS selector to REAL-click at t=0 (e.g. a menu button, a tab).'),
      elements: z.boolean().optional().describe('FILMSTRIP: also run the element probe (default true). Set false to save a little CPU.'),
      saveVideo: z.boolean().optional().describe('FILMSTRIP: also encode the recording as .webm under assets/references/web/<site>/ for the user (deliver_files to hand it over).'),
    },
    async ({ fullPage, selector, scrollTo, frames, scrollBy, trigger, click, elements, saveVideo }) => {
      try {
        return await withBrowser(projectId, async ({ page }) => {
          if (scrollTo != null) await scrollViewportTo(page, scrollTo);

          // ── 胶片条 ──
          if (frames && frames.length) {
            const wanted = [...frames].sort((a, b) => a - b);
            const durationMs = Math.max(300, Math.round(Math.max(...wanted)));
            const y0 = await page.evaluate(() => window.scrollY).catch(() => 0);
            const during = scrollBy ? (p) => wheelScroll(p, { px: scrollBy, durationMs: Math.max(200, durationMs - 100) }) : null;
            const rec = await recordMotion(page, {
              durationMs, trigger, click, during, probeElements: elements !== false,
              shotMaxW: VP.width, shotMaxH: VP.height,
            });
            if (!rec.shots.length) {
              return asText(['Filmstrip failed: the screencast captured zero frames — the page never painted during the window.', rec.clickNote, rec.triggerNote, rec.duringNote].filter(Boolean).join('\n'), true);
            }
            const picked = pickNearestFrames(rec.shots, wanted);
            const sheet = await composeSheet(picked);
            const y1 = await page.evaluate(() => window.scrollY).catch(() => y0);
            const probe = elements !== false ? elementMotionReport(rec.elems, { scrolledPx: y1 - y0 }) : null;
            let videoNote = null;
            if (saveVideo && workspaceRoot) {
              try {
                const host = (() => { try { return new URL(page.url()).hostname.replace(/[^a-z0-9.-]/gi, '').replace(/\./g, '-'); } catch { return 'site'; } })();
                const rel = path.posix.join('assets', 'references', 'web', host, `motion-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.webm`);
                const { bytes } = await encodeWebm(rec.shots, path.join(workspaceRoot, rel));
                videoNote = `video saved: ${rel} (${(bytes / 1024).toFixed(0)}KB, real frame timing) — deliver_files to hand it to the user`;
              } catch (err) { videoNote = `video encode failed: ${err?.message || err}`; }
            }
            const shot = await normalizeShot(sheet.buf);
            const cells = picked.map((p, i) => (p ? `#${i + 1} t=${Math.round(p.want)}ms→${Math.round(p.actual)}ms` : `#${i + 1} (no frame)`)).join('  ');
            const cap = [
              `Filmstrip of ${await where(page)} — ${wanted.length} cells, ${sheet.layout.cols}x${sheet.layout.rows} grid, viewport ${VP.width}x${VP.height} (t=0 = when ${scrollBy ? 'wheel scrolling' : trigger ? 'trigger' : click ? 'click' : 'recording'} started)`,
              cells,
              ...(probe ? elementMotionLines(probe) : []),
              ...motionCaptionLines(rec),
              ...(videoNote ? [videoNote] : []),
              shot.note,
              'Next: browser_capture{kinds:["motion"]} for WHAT the site uses (keyframes/transitions/scroll-timeline/libraries); zoom a cell region with browser_computer zoom if the cells are too small.',
            ].filter(Boolean);
            return { content: [{ type: 'text', text: cap.join('\n') }, { type: 'image', data: shot.data, mimeType: shot.mimeType }] };
          }

          // ── 静帧 ──
          let buf;
          if (selector) {
            const loc = page.locator(selector).first();
            if (!(await loc.count())) return asText(`选择器没匹配到元素：${selector}`, true);
            buf = await loc.screenshot({ type: 'png', scale: 'css' });
          } else {
            buf = await page.screenshot({ type: 'png', fullPage: fullPage === true, scale: 'css' });
            // 顺手把这张存成桌面卡片的预览 —— **不额外截图**，只是这一张本来就有。
            // 整页图不用：卡片是一块 16:10 的画框，塞一张长图进去看不出东西。
            if (fullPage !== true) await saveFrame(projectId, buf);
          }
          const shot = await normalizeShot(buf);
          return {
            content: [
              { type: 'text', text: [`${await where(page)}`,
                selector ? `只截了 ${selector}` : `${fullPage ? '整页' : '视口'} ${VP.width}×${VP.height}${fullPage ? '' : ` (≈${visionTokens(VP.width, VP.height)} tokens)`}`,
                shot.note].filter(Boolean).join(' · ') },
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
            ],
          };
        });
      } catch (err) {
        return asText(`browser_screenshot 失败：${err.message}`, true);
      }
    },
  );
}
