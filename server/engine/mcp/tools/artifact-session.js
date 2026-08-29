/**
 * mcp/tools/artifact-session.js — 产物会话四件：artifact_open / artifact_computer /
 * artifact_find / artifact_batch（2026-08-21）
 *
 * 成品检查的交互半边。以前七个感知工具全是一次性的（开一只新浏览器、量、关），
 * "点开菜单 → 填表 → 提交 → 看校验"只能靠 beforeShot 塞 JS 假装；hover 态、焦点
 * 顺序、方向键连按、拖拽、pointer lock 这些只认真实手势。现在：
 *
 *   artifact_open      打开（或重载）一个产物到常驻会话，状态跨调用留着
 *   artifact_computer  browser_computer 同一套动作（runAction 共享一份），对着会话页
 *   artifact_find      词法找元 → ref（refs.js 共享一份）
 *   artifact_batch     一次往返跑一串（makeBatchTool 共享一份合同）
 *
 * 老工具（screenshot_canvas / trace_motion / get_computed_styles / explain_style /
 * query_elements）加 `live:true` 就对着会话里**现在这一页**量，胶片条/示波器/级联
 * 解释全能骑在交互态上 —— 那是它们各自独有、browser use 没有的量具。
 *
 * 坐标：产物视口按形态定（站 1440×900、deck 1920×1080…），截图可能被归一化缩过，
 * 会话记 frame={w,h,scale}，模型读到的坐标 ÷ scale = 页面像素。artifact_open 的
 * 返回会把截图尺寸说清楚。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { openSession, withSession, changedSinceOpen, peekSession, defaultViewportFor } from '../../perception/session.js';
import { findInPage, formatMatches } from '../../browse/refs.js';
import { runAction, ACTIONS_DOC, COMPUTER_SCHEMA, actionErrorText } from './browse-computer.js';
import { makeBatchTool, HALT_TEXT } from './browse-find-batch.js';
import { normalizeShot, visionTokens } from './helpers/shot-pipeline.js';
import { degradedNote } from './helpers/perception-page.js';
import { acquireArtifactPage, LIVE_PARAM_DESC } from './helpers/acquire-page.js';
import { collectMotionInventory, formatMotionInventory } from '../../motion/inventory.js';
import { CANVAS_PATH_DESC, resolveCanvasTarget, requireBrowsable } from '../../../lib/artifact-target.js';

const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** 会话页截图（不存桌面卡 —— 那是浏览通道的事）；caption 说清截图空间 */
async function sessionShot(entry, lead) {
  const buf = await entry.page.screenshot({ type: 'png' });
  const shot = await normalizeShot(buf);
  const f = entry.frame;
  return {
    content: [
      { type: 'text', text: [lead, `${f.w}×${f.h} (${f.scale < 1 ? `viewport ${entry.viewport.width}×${entry.viewport.height} scaled ×${f.scale.toFixed(2)}; ` : ''}coordinates you use next are these screenshot pixels, ≈${visionTokens(f.w, f.h)} tokens)`, shot.note].filter(Boolean).join(' · ') },
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
    ],
  };
}

async function changedNote(entry) {
  const changed = await changedSinceOpen(entry);
  if (!changed.length) return null;
  const shown = changed.slice(0, 5).join(', ');
  return `⚠ files changed since this page was opened (${shown}${changed.length > 5 ? ` +${changed.length - 5}` : ''}) — the page is showing the OLD version. artifact_open again to reload (state resets).`;
}

export function makeArtifactOpenTool({ projectId, workspaceRoot, sessionId }) {
  return tool(
    'artifact_open',
    `Open one of your artifacts (a site page, a deck, a game) in a persistent
session browser — the starting point for interactive checking. Unlike
screenshot_canvas (fresh load every call), the page stays open between calls:
menus you open stay open, text you type stays typed, a game keeps its state.
Then use artifact_computer (click / type / keys / drag / scroll / zoom /
screenshot), artifact_find (element refs), artifact_batch (several steps in one
round trip), and the measuring tools with live:true (screenshot_canvas filmstrip,
trace_motion, get_computed_styles, explain_style, query_elements) to inspect
the CURRENT interactive state.

Opening the same file again reloads it (state resets). Opening a different file
or device replaces the session. The page is loaded over http like the user
preview (fetch/localStorage behave the same). After you edit files the open page
is stale — every artifact_* result reminds you; reopen to see the new version.

Returns the screenshot size: coordinates you pass to artifact_computer are
pixels of that screenshot (a deck at 1920×1080 is scaled down to fit the vision
limit; the mapping is handled for you).`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
      device: z.enum(['desktop', 'tablet', 'mobile']).optional()
        .describe('SITE ONLY. Real device width to render at: desktop=1440, tablet=834, mobile=390. Default desktop.'),
      viewport: z.object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(2560) }).optional()
        .describe('Explicit viewport; defaults to the artifact kind (site → device width × 900, deck → its aspect).'),
    },
    async ({ path: relPath, device, viewport }) => {
      try {
        const { entry, reloaded, gotoNote } = await openSession({ projectId, workspaceRoot, sessionId, relPath, device, viewport });
        const f = entry.frame;
        const lines = [
          `${reloaded ? 'Reloaded' : 'Opened'} ${entry.target.relPath} (${entry.target.kind}) at viewport ${entry.viewport.width}×${entry.viewport.height}.`,
          `Screenshots are ${f.w}×${f.h}${f.scale < 1 ? ` (viewport scaled ×${f.scale.toFixed(2)} to fit the vision limit — you still just use screenshot pixels)` : ' (1:1 with the viewport)'}, ≈${visionTokens(f.w, f.h)} tokens each.`,
          entry.viaHttp ? 'Loaded over http, same origin as the user preview.' : null,
          degradedNote(entry),
          gotoNote,
          'Next: artifact_computer screenshot to look, artifact_find to get refs, or artifact_batch to do several steps at once.',
        ].filter(Boolean);
        return asText(lines.join('\n'));
      } catch (err) {
        return asText(`artifact_open 失败：${err.message}`, true);
      }
    },
  );
}

export function makeArtifactComputerTool({ projectId }) {
  return tool(
    'artifact_computer',
    `Pointer, keyboard and pixel-level capture on the page open in the artifact
session (artifact_open first). Same actions as browser_computer, aimed at YOUR
artifact: click through your own UI, fill your own forms, play your own game
with real key presses, drag your own sliders, hover to reveal your own tooltips,
zoom into your own small text.

Coordinates are pixels of the session screenshot (origin top-left; size is
reported by artifact_open and by every screenshot). After zoom, coordinates
are STILL full-screenshot pixels. Or target an element by ref from
artifact_find.

${ACTIONS_DOC}

One action per call. For a sequence (click field → type → Enter → look) use
artifact_batch. To MEASURE the state you reached (easing filmstrip, computed
styles, cascade), call screenshot_canvas / trace_motion / get_computed_styles /
explain_style / query_elements with live:true.`,
    COMPUTER_SCHEMA,
    async (a) => {
      try {
        return await withSession(projectId, async (entry) => {
          const { page } = entry;
          const before = page.url();
          // 站内导航（点了 about.html）也要报：判据同 browser_computer —— 主帧发出导航请求
          let navStarted = false;
          const onReq = (req) => { try { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navStarted = true; } catch { /* */ } };
          page.on('request', onReq);
          let r;
          try {
            r = await runAction(page, a, { frame: entry.frame, shot: (_p, lead) => sessionShot(entry, lead) });
          } catch (err) {
            page.off('request', onReq);
            return asText(actionErrorText(a.action, err), true);
          }
          if (/click|key|type/.test(a.action) && !page.isClosed()) await page.waitForTimeout(250);
          page.off('request', onReq);
          if (!page.isClosed() && (navStarted || page.url() !== before)) {
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
          }
          if (!page.isClosed() && page.url() !== before) {
            const title = await page.title().catch(() => '');
            let where = page.url();
            try { where = decodeURIComponent(new URL(where).pathname.replace(/^.*\/artifact-file\//, '')); } catch { /* */ }
            r.content.unshift({ type: 'text', text: `→ page changed: ${title || '(no title)'} — ${where} (refs from before are gone)` });
          }
          const note = await changedNote(entry);
          if (note) r.content.push({ type: 'text', text: note });
          return r;
        });
      } catch (err) {
        return asText(`artifact_computer 失败：${err.message}`, true);
      }
    },
  );
}

export function makeArtifactFindTool({ projectId }) {
  return tool(
    'artifact_find',
    `Find elements on the page open in the artifact session by describing them
("submit button", "price input", "第二张卡片 链接"). Returns up to 20 matches
with refs (ref_N) for artifact_computer and their screenshot coordinates.
Matching is LEXICAL (visible text / aria-label / placeholder / alt / role /
href), not semantic — use the words that appear on the element. You wrote this
page, so a CSS selector via query_elements is often just as good; refs shine for
canvas/WebGL UIs and anything you'd otherwise have to click by pixel. Refs die
on reload/navigation.`,
    {
      query: z.string().min(1).max(120).describe('Words shown on the element plus an optional role word.'),
      limit: z.number().int().min(1).max(20).optional().describe('Max matches (default 20).'),
    },
    async ({ query, limit }) => {
      try {
        return await withSession(projectId, async (entry) => {
          const r = await findInPage(entry.page, { query, limit: limit ?? 20 });
          const s = entry.frame.scale;
          if (s < 1) {
            r.matches = r.matches.map(m => ({ ...m, x: Math.round(m.x * s), y: Math.round(m.y * s), w: Math.round(m.w * s), h: Math.round(m.h * s) }));
          }
          const lines = formatMatches(r, query).map(l => l.replace('browser_computer', 'artifact_computer').replace('browser_read', 'query_elements').replace('browser_find', 'artifact_find'));
          const note = await changedNote(entry);
          return asText([...lines, note].filter(Boolean).join('\n'));
        });
      } catch (err) {
        return asText(`artifact_find 失败：${err.message}`, true);
      }
    },
  );
}

/**
 * artifact_motion：自己的产物"靠什么在动"——跟 browser_capture 的 motion 档**同一份引擎**
 * （engine/motion/inventory.js），只是对着产物页。默认新开一只可复现；live:true 对着会话页
 * （会真滚一遍再滚回顶，reveal 会被触发 —— 查交互态之前先想清楚要不要）。
 */
export function makeArtifactMotionTool({ projectId, workspaceRoot, sessionId }) {
  return tool(
    'artifact_motion',
    `Inventory of WHAT moves on your artifact page and how: every stylesheet
scanned for @keyframes / animation / transition / CSS scroll-driven animation
(animation-timeline, scroll(), view()) / scroll-snap / sticky / reduced-motion;
the browser's running animations (getAnimations: durations, easings, keyframes);
motion libraries (GSAP + each ScrollTrigger's start/end/scrub/pin, Lenis, AOS…);
and a REAL wheel scroll through the page that tells apart reveal-on-scroll
elements (with their transition), scrub/parallax elements, and scroll hijacking.

Same engine as browser_capture{kinds:['motion']} on reference sites — so you can
compare "theirs vs mine" on equal terms: did my reveals actually wire up, is my
ScrollTrigger range what I meant, did I forget prefers-reduced-motion. Pure
declarations in your CSS you can Read; this tells you what the BROWSER sees at
runtime, which is what the user sees.

Fresh load by default (reproducible). live:true runs it on the artifact session's
current page (it scrolls the page and returns to top — reveals get triggered).
For how the motion LOOKS use screenshot_canvas frames; for numbers use trace_motion.`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
      device: z.enum(['desktop', 'tablet', 'mobile']).optional().describe('SITE ONLY, fresh-load mode: viewport width to inventory at (default desktop).'),
      live: z.boolean().optional().describe(LIVE_PARAM_DESC),
    },
    async ({ path: relPath, device, live }) => {
      let acq;
      try {
        const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
        if (!target || !target.ok) return asText(target?.message || 'No artifact found — pass path.', true);
        const guard = requireBrowsable(target);
        if (guard) return asText(guard, true);
        const vp = await defaultViewportFor(target, device);
        acq = await acquireArtifactPage({ projectId, workspaceRoot, target, live, viewport: vp });
        const inv = await collectMotionInventory(acq.page);
        const lines = [
          `motion inventory — ${target.relPath} @ ${acq.viewport.width}x${acq.viewport.height}`,
          degradedNote(acq), acq.liveNote, acq.gotoNote, '',
          ...formatMotionInventory(inv),
          '', '→ to SEE it: screenshot_canvas { frames:[2-30 ms offsets], trigger/click or live:true }; to MEASURE a curve: trace_motion.',
        ].filter(l => l != null);
        return asText(lines.join('\n'));
      } catch (err) {
        return asText(`artifact_motion 失败：${err.message}`, true);
      } finally {
        await acq?.release?.();
      }
    },
  );
}

/** artifact_batch 能跑的：会话四件 + 五个能 live 的量具（它们在 batch 里要自己带 live:true） */
export const ARTIFACT_BATCHABLE = [
  'artifact_open', 'artifact_computer', 'artifact_find', 'artifact_motion',
  'screenshot_canvas', 'trace_motion', 'get_computed_styles', 'explain_style', 'query_elements',
];

export function makeArtifactBatchTool({ tools, resolve = null }) {
  const names = ARTIFACT_BATCHABLE.filter(n => tools.some(t => t.name === n));
  return makeBatchTool({
    name: 'artifact_batch',
    tools,
    resolve,
    batchable: ARTIFACT_BATCHABLE,
    finalShot: { name: 'artifact_computer', input: { action: 'screenshot' } },
    description: `Run several artifact-session steps in ONE round trip: open → click → type →
key → look, or click → trace_motion(live:true) → screenshot. Items run in order
and STOP at the first error; later items get "${HALT_TEXT}". A session
screenshot is appended at the end unless the last item already produced an
image (or screenshotAfter:false). Measuring tools inside a batch need
live:true in their input or they will open their own fresh page. Coordinates
refer to the screenshot you saw BEFORE the call. Batchable: ${names.join(', ')}.
Example: [{"name":"artifact_open","input":{}},{"name":"artifact_find","input":{"query":"start button"}},{"name":"artifact_computer","input":{"action":"left_click","ref":"ref_1"}},{"name":"artifact_computer","input":{"action":"key","text":"ArrowRight","repeat":10}},{"name":"screenshot_canvas","input":{"live":true,"frames":[0,120,240,480]}}]`,
  });
}

export { peekSession };
