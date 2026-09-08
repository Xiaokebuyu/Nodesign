/**
 * mcp/tools/browse-computer.js — browser_computer：坐标/引用级的指针与键盘（2026-08-21）
 *
 * 形状照 Anthropic 的 browser use toolset（`browser_toolset_20260801`）的指针/键盘/
 * 截图成员：left_click … zoom 那一组，成员名、参数名、语义一字不改；外壳是 MCP 单
 * 工具 + `action` 枚举（Claude in Chrome 的 `computer` 工具就是这么包的）。
 * 规格里的 `target`（coordinate | ref 二选一）拆成 `coordinate` / `ref` 两个字段。
 *
 * ## 为什么不等 toolset 进 Agent SDK
 *
 * toolset 是 Messages API 请求体里的东西，Agent SDK 的设计点是"自带工具 + MCP"，
 * 两边不相交（08-21 查过 0.3.237/0.3.238 两版二进制，零痕迹）。而模型认的是
 * **动作名和参数形状**，不是 `toolset_name` 字段 —— Claude in Chrome 用 MCP 包同一
 * 套动作照样熟练。所以这里直接做 MCP，订阅通路和本地模型通路一视同仁。
 *
 * ## 坐标空间 = 截图像素；frame 负责它和页面像素的换算
 *
 * `runAction(page, a, { frame, shot })` 对"页面从哪来"无知：浏览通道传
 * frame={1366,768,scale 1}（视口 1366×768 在 shot-pipeline 阈值内，截图不缩，
 * 1:1）；产物会话（artifact_computer）按产物视口算 frame，scale 可能 <1，模型读到
 * 的坐标 ÷ scale 才是页面像素（文档推荐做法）。所有回给模型的坐标都是截图空间。
 *
 * ## 闸不用动
 *
 * 出网闸在进程内 HTTP 代理（lib/browse-proxy.js），在 Playwright 之下；点哪里都
 * 绕不过去。这是 headless 页面，没有地址栏、没有 OS 对话框，不存在桌面 computer
 * use 那种"从浏览器逃到终端"的面。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withBrowser, _limits } from '../../browse/registry.js';
import { handleForRef, staleRefText } from '../../browse/refs.js';
import { recordVisit, saveFrame } from '../../browse/state.js';
import { normalizeShot } from './helpers/shot-pipeline.js';

const VP = _limits.VIEWPORT;
/** 浏览通道的截图空间：视口像素 1:1（browse-computer.test.js 守着这个前提） */
export const BROWSE_FRAME = { w: VP.width, h: VP.height, scale: 1 };
const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

export const ACTIONS = [
  'screenshot', 'zoom',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'hover',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'mouse_move',
  'scroll', 'scroll_to',
  'type', 'key', 'hold_key', 'wait',
];

// ── 键名 / 修饰键：模型写的是 xdotool 风格（Return、ctrl+s、Page_Down），
//    Playwright 要 DOM 键名（Enter、Control+s、PageDown）──
const KEY_ALIAS = {
  return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', page_up: 'PageUp', pagedown: 'PageDown', page_down: 'PageDown',
  capslock: 'CapsLock', caps_lock: 'CapsLock',
};
const MOD_ALIAS = {
  shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt',
  cmd: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
};

/** 'ctrl+shift' → ['Control','Shift']；不认识的词抛错（别静默吞成无修饰） */
export function parseModifiers(s) {
  if (!s) return [];
  return String(s).split('+').map(p => p.trim()).filter(Boolean).map((p) => {
    const m = MOD_ALIAS[p.toLowerCase()];
    if (!m) throw new Error(`unknown modifier "${p}" (use shift / ctrl / alt / cmd, joined with +)`);
    return m;
  });
}

/** 'ctrl+s' / 'Return' / 'Backspace Backspace' → [['Control','s'], ...]（每个和弦 = 修饰键…+主键） */
export function parseChords(text) {
  const chords = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!chords.length) throw new Error('key needs a key name, e.g. "Enter", "ctrl+a", "Backspace Backspace"');
  return chords.map((chord) => {
    const parts = chord.split('+').filter(Boolean);
    if (chord === '+' || !parts.length) parts.splice(0, parts.length, '+');
    const keyRaw = parts[parts.length - 1];
    const mods = parts.slice(0, -1).map((p) => {
      const m = MOD_ALIAS[p.toLowerCase()];
      if (!m) throw new Error(`unknown modifier "${p}" in "${chord}"`);
      return m;
    });
    const lower = keyRaw.toLowerCase();
    let key = KEY_ALIAS[lower];
    if (!key && MOD_ALIAS[lower]) throw new Error(`"${chord}" is only modifiers — add the key to press (e.g. "${chord}+a"), or use hold_key`);
    if (!key && /^f([1-9]|1[0-2])$/i.test(keyRaw)) key = `F${keyRaw.slice(1)}`;
    if (!key) key = keyRaw.length === 1 ? keyRaw : keyRaw[0].toUpperCase() + keyRaw.slice(1);
    return [...mods, key];
  });
}

/** 坐标校验（截图空间）：必须落在 frame 里 —— 坐标空间就是截图像素，越界只能是读错了图 */
export function checkCoord(c, frame = BROWSE_FRAME, label = 'coordinate') {
  if (!Array.isArray(c) || c.length !== 2 || !c.every(n => Number.isFinite(n))) {
    return `${label} must be [x, y] in screenshot pixels`;
  }
  const [x, y] = c;
  if (x < 0 || y < 0 || x > frame.w || y > frame.h) {
    return `${label} (${x}, ${y}) is outside the ${frame.w}×${frame.h} screenshot — coordinates are screenshot pixels, origin top-left`;
  }
  return null;
}

const toPage = (v, frame) => v / frame.scale;
const toShot = (v, frame) => Math.round(v * frame.scale);

const cursors = new WeakMap();   // page → {x,y} 页面像素，给省略坐标的 mouse_down/up/scroll 用
const cursorOf = (page, frame) => cursors.get(page) || { x: toPage(frame.w / 2, frame), y: toPage(frame.h / 2, frame) };
const moveTo = async (page, x, y) => { await page.mouse.move(x, y); cursors.set(page, { x, y }); };

/**
 * coordinate / ref → {x,y(页面像素), sx,sy(截图像素), viaRef}。ref 会先滚进视口再取几何中心。
 */
async function resolveTarget(page, { coordinate, ref }, frame, { required = true } = {}) {
  if (ref) {
    const h = await handleForRef(page, ref);
    if (!h) return { error: staleRefText(ref) };
    await h.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const box = await h.boundingBox();
    if (!box) return { error: `Error: ${ref} has no visible box on the page (hidden or zero-size).` };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const sx = toShot(x, frame); const sy = toShot(y, frame);
    // 滚了还在视口外（典型：藏在屏幕上方的 skip link）—— 别夹到边上去点个错的地方
    if (sx < 0 || sy < 0 || sx > frame.w || sy > frame.h) {
      return { error: `Error: ${ref} sits off-screen at (${sx}, ${sy}) even after scrolling it into view (probably a visually-hidden element) — pick another match or click a coordinate you can see.` };
    }
    // 真跑逮到的：站点自己的开场幕布盖着整页，点 ref 其实点在幕布上，页面一点反应
    // 没有，agent 只能猜。查一下这个点最上层是谁；不是 ref 本身或它的祖/后代就报出来。
    let coveredBy = null;
    try {
      coveredBy = await h.evaluate((el, [px, py]) => {
        const top = document.elementFromPoint(px, py);
        if (!top || top === el || el.contains(top) || top.contains(el)) return null;
        const cls = typeof top.className === 'string' && top.className.trim() ? `.${top.className.trim().split(/\s+/)[0]}` : '';
        return `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${cls}`;
      }, [x, y]);
    } catch { /* 查不到就不报 */ }
    return { x, y, sx, sy, viaRef: ref, coveredBy };
  }
  if (coordinate) {
    const bad = checkCoord(coordinate, frame);
    if (bad) return { error: `Error: ${bad}` };
    return { x: toPage(coordinate[0], frame), y: toPage(coordinate[1], frame), sx: coordinate[0], sy: coordinate[1] };
  }
  if (required) return { error: 'Error: this action needs a coordinate [x, y] or a ref (from the find tool).' };
  const c = cursorOf(page, frame);
  return { ...c, sx: toShot(c.x, frame), sy: toShot(c.y, frame) };
}

async function withModifiers(page, mods, fn) {
  for (const m of mods) await page.keyboard.down(m);
  try { return await fn(); } finally {
    for (const m of [...mods].reverse()) await page.keyboard.up(m).catch(() => {});
  }
}

/** 浏览通道的视口截图：存桌面卡预览 + 归一化（1366×768 在阈值内，不缩）→ 文本块在前，图在后 */
export async function viewportShot(page, projectId, lead) {
  const buf = await page.screenshot({ type: 'png', scale: 'css' });
  await saveFrame(projectId, buf);
  const shot = await normalizeShot(buf);
  return {
    content: [
      { type: 'text', text: [lead, `viewport ${VP.width}×${VP.height} — coordinates you use next are these pixels`, shot.note].filter(Boolean).join(' · ') },
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
    ],
  };
}

async function zoomShot(page, region, frame, lead) {
  if (!Array.isArray(region) || region.length !== 4 || !region.every(n => Number.isFinite(n))) {
    return asText('Error: zoom needs region [x0, y0, x1, y1] in screenshot pixels.', true);
  }
  const [x0, y0, x1, y1] = region.map(Math.round);
  if (x0 < 0 || y0 < 0 || x1 > frame.w || y1 > frame.h || x1 - x0 < 8 || y1 - y0 < 8) {
    return asText(`Error: zoom region [${region.join(', ')}] must lie inside the ${frame.w}×${frame.h} LIVE VIEWPORT and be at least 8×8. `
      + 'zoom takes viewport pixels — coordinates from a fullPage screenshot are in page space and do NOT work here; scroll the target into view first, or subtract the scroll offset.', true);
  }
  const clip = { x: toPage(x0, frame), y: toPage(y0, frame), width: toPage(x1 - x0, frame), height: toPage(y1 - y0, frame) };
  const buf = await page.screenshot({ type: 'png', clip, scale: 'css' });
  const { default: sharp } = await import('sharp');
  const k = Math.min(frame.w / (x1 - x0), frame.h / (y1 - y0));   // 放大到塞满截图空间
  const up = await sharp(buf)
    .resize({ width: Math.round((x1 - x0) * k), height: Math.round((y1 - y0) * k), fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
    .png().toBuffer();
  const shot = await normalizeShot(up);
  return {
    content: [
      { type: 'text', text: `${lead}zoom of [${x0},${y0},${x1},${y1}] (${x1 - x0}×${y1 - y0}, ×${(k / frame.scale).toFixed(1)}) — the coordinates you use next are STILL full-screenshot pixels, not pixels of this zoomed image` },
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
    ],
  };
}

/**
 * 跑一个动作。返回 CallToolResult。导航变化与闸拦截由调用方补到文本里。
 * @param {import('playwright').Page} page
 * @param {object} a  工具入参
 * @param {{frame:{w:number,h:number,scale:number}, shot:(page:any, lead:string)=>Promise<any>}} env
 */
export async function runAction(page, a, { frame, shot }) {
  const { action } = a;
  if (action === 'screenshot') return shot(page, 'screenshot');
  if (action === 'zoom') return zoomShot(page, a.region, frame, '');
  if (action === 'wait') {
    const s = Math.min(30, Math.max(0, Number(a.duration) || 0));
    await page.waitForTimeout(s * 1000);
    return asText(`waited ${s}s`);
  }
  if (action === 'type') {
    if (typeof a.text !== 'string' || !a.text.length) return asText('Error: type needs text.', true);
    await page.keyboard.type(a.text);
    return asText(`typed ${a.text.length} chars at the current focus`);
  }
  if (action === 'key') {
    const chords = parseChords(a.text);
    const n = Math.min(100, Math.max(1, Math.round(Number(a.repeat) || 1)));
    for (let i = 0; i < n; i += 1) for (const c of chords) await page.keyboard.press(c.join('+'));
    return asText(`pressed ${chords.map(c => c.join('+')).join(' ')}${n > 1 ? ` ×${n}` : ''}`);
  }
  if (action === 'hold_key') {
    const [chord] = parseChords(a.text);
    const s = Math.min(30, Math.max(0, Number(a.duration) || 0));
    for (const k of chord) await page.keyboard.down(k);
    try { await page.waitForTimeout(s * 1000); } finally { for (const k of [...chord].reverse()) await page.keyboard.up(k).catch(() => {}); }
    return asText(`held ${chord.join('+')} for ${s}s`);
  }
  if (action === 'scroll_to') {
    if (!a.ref) return asText('Error: scroll_to needs a ref (from the find tool).', true);
    const h = await handleForRef(page, a.ref);
    if (!h) return asText(staleRefText(a.ref), true);
    await h.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await page.waitForTimeout(200);
    const box = await h.boundingBox();
    return asText(box ? `scrolled ${a.ref} into view — now at (${toShot(box.x + box.width / 2, frame)}, ${toShot(box.y + box.height / 2, frame)})` : `scrolled toward ${a.ref} (it has no visible box)`);
  }
  if (action === 'scroll') {
    const t = await resolveTarget(page, a, frame, { required: false });
    if (t.error) return asText(t.error, true);
    const dir = a.scroll_direction;
    if (!['up', 'down', 'left', 'right'].includes(dir)) return asText('Error: scroll needs scroll_direction up|down|left|right.', true);
    const amt = Math.min(10, Math.max(1, Math.round(Number(a.scroll_amount) || 3)));
    const mods = parseModifiers(a.modifiers);
    const before = await page.evaluate(() => [window.scrollX, window.scrollY]);
    await moveTo(page, t.x, t.y);
    const d = 100 * amt;
    await withModifiers(page, mods, () => page.mouse.wheel(
      dir === 'left' ? -d : dir === 'right' ? d : 0,
      dir === 'up' ? -d : dir === 'down' ? d : 0,
    ));
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => [window.scrollX, window.scrollY]);
    const moved = before[0] !== after[0] || before[1] !== after[1];
    return asText(`scrolled ${dir} ${amt} notches at (${t.sx}, ${t.sy})`
      + (moved ? ` — scrollY ${before[1]} → ${after[1]}${before[0] !== after[0] ? `, scrollX ${before[0]} → ${after[0]}` : ''}`
        : ' — the window itself did not move (maybe a scrollable panel under the cursor took it, or the page is at its end; try the keyboard: key PageDown)'));
  }
  // ── 指针动作 ──
  const mods = parseModifiers(a.modifiers);
  if (action === 'left_click_drag') {
    const from = await resolveTarget(page, { coordinate: a.start_coordinate }, frame, { required: true });
    if (from.error) return asText(from.error.replace('this action needs a coordinate', 'left_click_drag needs start_coordinate'), true);
    const to = await resolveTarget(page, a, frame);
    if (to.error) return asText(to.error, true);
    await withModifiers(page, mods, async () => {
      await moveTo(page, from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    });
    cursors.set(page, { x: to.x, y: to.y });
    return asText(`dragged (${from.sx}, ${from.sy}) → (${to.sx}, ${to.sy})`);
  }
  if (action === 'left_mouse_down' || action === 'left_mouse_up') {
    const t = await resolveTarget(page, a, frame, { required: false });
    if (t.error) return asText(t.error, true);
    await moveTo(page, t.x, t.y);
    if (action === 'left_mouse_down') await page.mouse.down(); else await page.mouse.up();
    return asText(`${action} at (${t.sx}, ${t.sy})`);
  }
  const t = await resolveTarget(page, a, frame);
  if (t.error) return asText(t.error, true);
  const at = `(${t.sx}, ${t.sy})${t.viaRef ? ` = ${t.viaRef}` : ''}`
    + (t.coveredBy ? ` — ⚠ that point is covered by <${t.coveredBy}>: the ${action} landed on it, not on ${t.viaRef} (overlay / curtain / modal? dismiss it first or screenshot to see)` : '');
  if (action === 'mouse_move' || action === 'hover') {
    await moveTo(page, t.x, t.y);
    await page.waitForTimeout(150);
    return asText(`${action} ${at}`);
  }
  const CLICKS = {
    left_click: { button: 'left', clickCount: 1 },
    right_click: { button: 'right', clickCount: 1 },
    middle_click: { button: 'middle', clickCount: 1 },
    double_click: { button: 'left', clickCount: 2 },
    triple_click: { button: 'left', clickCount: 3 },
  };
  const spec = CLICKS[action];
  if (!spec) return asText(`Error: unknown action "${action}".`, true);
  await withModifiers(page, mods, async () => {
    await moveTo(page, t.x, t.y);
    await page.mouse.click(t.x, t.y, spec);
  });
  return asText(`${action} ${at}${mods.length ? ` with ${mods.join('+')}` : ''}`);
}

/** 动作描述正文，browser_computer / artifact_computer 共用（坐标空间那句由各自补） */
export const ACTIONS_DOC = `Actions (params in parentheses):
  screenshot ()                         current view as an image
  zoom (region [x0,y0,x1,y1])           region at higher magnification, for small text/icons
  left_click | right_click | middle_click | double_click | triple_click (coordinate or ref, modifiers?)
  hover | mouse_move (coordinate or ref)
  left_click_drag (start_coordinate, coordinate)
  left_mouse_down | left_mouse_up (coordinate?)   custom drags; pair them, move in between
  scroll (scroll_direction, scroll_amount? 1-10 notches, coordinate?)
  scroll_to (ref)                       scroll an element into view
  type (text)                           literal text at the current focus
  key (text, repeat? 1-100)             "Enter", "ctrl+a", "Backspace Backspace", "alt+Tab"
  hold_key (text, duration ≤30s)
  wait (duration ≤30s)`;

/** 入参 schema，两个 computer 工具共用 */
export const COMPUTER_SCHEMA = {
  action: z.enum(ACTIONS).describe('Which action to perform (see the list above).'),
  coordinate: z.array(z.number()).length(2).optional()
    .describe('[x, y] screenshot pixels. Target for clicks/hover/mouse_move/scroll, and the END point of left_click_drag.'),
  start_coordinate: z.array(z.number()).length(2).optional()
    .describe('[x, y] START point for left_click_drag.'),
  ref: z.string().optional()
    .describe('Element reference from the find tool (e.g. "ref_3"). Alternative to coordinate for clicks/hover; required for scroll_to.'),
  region: z.array(z.number()).length(4).optional()
    .describe('[x0, y0, x1, y1] for zoom: top-left and bottom-right corners in screenshot pixels.'),
  text: z.string().optional()
    .describe('For type: the literal text. For key/hold_key: a key or +-chord, space-separated for a sequence ("Enter", "ctrl+s", "shift+Tab Tab").'),
  modifiers: z.string().optional()
    .describe('Modifier chord held during a click or scroll: shift / ctrl / alt / cmd, joined with + (e.g. "ctrl+shift").'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('For scroll.'),
  scroll_amount: z.number().int().min(1).max(10).optional().describe('For scroll: wheel notches, default 3.'),
  repeat: z.number().int().min(1).max(100).optional().describe('For key: press the sequence this many times, default 1.'),
  duration: z.number().min(0).max(30).optional().describe('Seconds, for wait and hold_key (max 30).'),
};

/** 动作抛的 Playwright 内部错 → agent 能行动的话（两个 computer 工具共用） */
export function actionErrorText(action, err) {
  const msg = String(err?.message || err).split('\n')[0];
  if (/Execution context was destroyed|Target closed|frame was detached/i.test(msg)) {
    return `Error: ${action} hit a page navigation in progress (${msg}). The page has changed underneath you — refs from before are stale; find again or screenshot first.`;
  }
  return `Error: ${action} failed: ${msg}`;
}

export function makeBrowserComputerTool({ projectId, ctx }) {
  return tool(
    'browser_computer',
    `Pointer, keyboard and pixel-level capture on the current page of this project's
browser — the coordinate half of browsing. browser_click/browser_read work by
selector and text; this one works the way a person does: look at a screenshot,
click at a pixel, type, press keys, zoom into a region.

Coordinates are viewport pixels of the screenshot you saw (origin top-left,
viewport ${VP.width}×${VP.height}, 1:1 — no scaling). After zoom, coordinates are STILL
full-viewport pixels. You can also target an element by ref from browser_find
(pass ref instead of coordinate) — refs survive layout shifts, pixels do not.

${ACTIONS_DOC}

Each call runs ONE action and returns a short acknowledgment (plus the new
location if the page navigated). When you can predict two or more steps — click
a field, type, press Enter, look — use browser_batch, which runs them in one
round trip and ends with a screenshot. Consent banners: find the button with
browser_find and click its ref.`,
    COMPUTER_SCHEMA,
    async (a) => {
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          const since = guard.blocked.length;
          const before = page.url();
          // 换页的判据是"主帧发出了导航请求"，不是"地址栏变了"：慢站（隧道 RTT 几百
          // 毫秒）点完 300ms 内响应还没回来、地址没变，但请求已经发出去了。真跑逮到
          // 两次"page changed 迟到一条命令"，都是这个原因。
          let navStarted = false;
          const onReq = (req) => { try { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navStarted = true; } catch { /* */ } };
          page.on('request', onReq);
          let r;
          try {
            r = await runAction(page, a, { frame: BROWSE_FRAME, shot: (p, lead) => viewportShot(p, projectId, lead) });
          } catch (err) {
            page.off('request', onReq);
            if (/Execution context was destroyed|Target closed|frame was detached/i.test(String(err?.message))) {
              await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            }
            return asText(actionErrorText(a.action, err), true);
          }
          // 点击/按键可能换页：留 300ms 让导航请求发出来，发出来了就等 DOM 就绪再回话
          if (/click|key|type/.test(a.action) && !page.isClosed()) await page.waitForTimeout(300);
          page.off('request', onReq);
          if (!page.isClosed() && (navStarted || page.url() !== before)) {
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
          }
          if (!page.isClosed() && page.url() !== before) {
            await recordVisit(projectId, page);
            try { ctx?.emit?.({ type: 'run.browser_opened', url: page.url(), ts: new Date().toISOString() }); } catch { /* */ }
            const title = await page.title().catch(() => '');
            r.content.unshift({ type: 'text', text: `→ page changed: ${title || '(no title)'} — ${page.url()}` });
          }
          const fresh = guard.blocked.slice(since);
          if (fresh.length) {
            r.content.push({ type: 'text', text: `⛔ network gate blocked ${fresh.length} request(s) during this action (internal/private addresses are a hard boundary).` });
          }
          return r;
        });
      } catch (err) {
        return asText(`browser_computer 失败：${err.message}`, true);
      }
    },
  );
}
