/**
 * mcp/tools/open-sheet.js —— open_sheet 铺纸（2026-08-29 纸范式刀 2）
 *
 * 开工先铺纸：在画布上登记一块 0.75 倍缩放下等于用户一屏的矩形工作区。
 * 铺在哪由机器定（第一张对准用户此刻的视口 —— 「agent 在用户眼皮底下开工」；
 * 之后缺省铺在当前纸正下方，像往桌上接着铺稿纸）。铺完这张纸就是**当前纸**：
 * write_on_board 的 at 坐标以它的版心左上角为原点，没给 at 的写入在纸内自动
 * 往下排，写满自动翻下一张。
 *
 * 纸是分配纪律不是容器，**也不渲染**（用户拍板：纸只是位置范围的概念）——用户
 * 看到的只有内容本身；纸的存在体现在落位秩序、翻纸导航和 read_board 的账本里。
 * 用户可以把东西拖出纸外，组照旧由 tag/线派生。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { byOf } from '../actor.js';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { fitFor, capacityOf, DEFAULT_CHALK_W } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import {
  sheetSizeFor, allocateSheetRect, nextSheetName, currentSheet, innerRect, SHEET_MARGIN,
  membersInRect, sheetMembers,
} from '../../../lib/board-sheets.js';
import { setCurrentSheetId, currentSheetIdOf } from '../../../lib/sheet-state.js';
import { Events } from '../../agent/events.js';
import { SHEET_PT } from './write-on-board-schema.js';

/** 一块地（版位）。坐标/尺寸全是纸内局部像素 —— 跟 write_on_board 的 at 同一套
 *（export 给 edit_board 的 replan 用 —— 版位的合法性只有这一份定义） */
export const SLOT = z.object({
  slot: z.string().regex(TAG_RE).describe('Name for this block, ASCII like main/aside/notes'),
  at: SHEET_PT.describe('Top-left of this block, pixels from the sheet\'s writable corner'),
  w: z.number().min(48).max(12000).describe('Width in PIXELS (a default note column is 432)'),
  h: z.number().min(24).max(12000).describe('Height in PIXELS (~26px per line of text)'),
  about: z.string().max(60).optional().describe('What goes here (正文 / 人物小传 / 待办) — for your own map'),
  for: z.literal('artifacts').optional()
    .describe("Set to 'artifacts' on ONE block to make it this page's landing spot for generated files (images, docs, sites). Without it, files you produce have nowhere planned to go and the page fills up with them wherever there is room."),
});

/**
 * 版面规划钳制（2026-08-29 刀 E；2026-08-30 抽出来给 replan 共用）：
 * 开工先把这一屏切成几块地。坐标跟 at 同一套（纸内局部像素）。
 * 越出版心的钳回来 —— 钳过如实报（规划错了要当场知道）。
 */
export function clampPlan(plan, inner0) {
  const slots = {};
  const clampedSlots = [];
  for (const it of Array.isArray(plan) ? plan : []) {
    const w = Math.min(Math.round(it.w), inner0.w);
    const h = Math.min(Math.round(it.h), inner0.h);
    const x = Math.min(Math.max(0, Math.round(it.at?.x ?? 0)), Math.max(0, inner0.w - w));
    const y = Math.min(Math.max(0, Math.round(it.at?.y ?? 0)), Math.max(0, inner0.h - h));
    if (x !== Math.round(it.at?.x ?? 0) || y !== Math.round(it.at?.y ?? 0)
      || w !== Math.round(it.w) || h !== Math.round(it.h)) clampedSlots.push(it.slot);
    slots[it.slot] = { x, y, w, h, ...(it.about ? { about: it.about } : {}), ...(it.for === 'artifacts' ? { for: 'artifacts' } : {}) };
  }
  return { slots, clampedSlots };
}

/**
 * 铺一张纸并登记（write_on_board 自动铺纸也走这一份 —— 分配纪律只有一份）。
 * @returns {{ id, x, y, w, h, innerW, innerH, basis, overlapsLoose }}
 */
export async function openSheetFor(projectId, {
  sessionId = null, by = 'agent', title = null, name = null, where = null, plan = null,
} = {}) {
  const board = await readBoard(projectId);
  const vp = getViewpoint(projectId);
  const fit = fitFor(vp);
  const size = sheetSizeFor(fit);
  let cur = currentSheet(board, currentSheetIdOf(sessionId));
  // 缺省：还没有纸（或点名 viewport）→ 对准用户视口；有当前纸 → 铺在它正下方
  const mode = where || (cur ? 'next' : 'viewport');
  // 翻页裁纸（刀② 2026-08-30）：纸固定一屏高、下一张贴满高矩形正下方，上一张
  // 只用了一半时内容之间就是几百像素的空白（proj_mtfpehm3 实测 268~557px，
  // 设计间隔明明只有 48）。翻页那一刻把上一张裁到内容底 —— 纸是分配纪律不是
  // 画出来的框，裁掉的只是"再也不会写进去的余白"；它的版位一并钳到新底。
  let trimmed = null;
  if (mode === 'next' && cur) {
    const members = sheetMembers(board, cur.id);
    const innerC = innerRect(cur);
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : innerC.y;
    const newH = Math.max(240, Math.ceil((bottom + SHEET_MARGIN - cur.y) / 24) * 24);
    if (newH < cur.h - 24) {
      const oldEntry = board.sheets[cur.id];
      const newSlots = {};
      for (const [nm, sl] of Object.entries(oldEntry.slots || {})) {
        newSlots[nm] = { ...sl, h: Math.max(24, Math.min(sl.h, newH - SHEET_MARGIN * 2 - sl.y)) };
      }
      const patched = { ...oldEntry, h: newH, ...(Object.keys(newSlots).length ? { slots: newSlots } : {}) };
      await patchBoard(projectId, { sheets: { [cur.id]: patched } });
      trimmed = { id: cur.id, from: cur.h, to: newH };
      board.sheets = { ...board.sheets, [cur.id]: patched };
      cur = { ...cur, h: newH };
    }
  }
  // 铺纸尽量不压散件。⛔ 不含文件夹/卷卡这类常驻家具：纸不渲染，纸矩形盖住文件夹
  // 用户什么也看不见，而纸内落位照样会避开它 —— 算进来只会把第一张纸推离用户视口。
  const obstacles = obstaclesIn(board, '', { furniture: false });
  const rect = allocateSheetRect({
    board, size,
    viewport: mode === 'viewport' && vp?.camera && !vp.layer ? vp.camera : null,
    nearSheet: mode === 'next' && cur ? cur.id : null,
    obstacles,
  });
  const id = (name && TAG_RE.test(name) && !board.sheets?.[name]) ? name : nextSheetName(board);
  const inner0 = innerRect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  const { slots, clampedSlots } = clampPlan(plan, inner0);
  const entry = {
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    by, at: new Date().toISOString(), ...(title ? { title } : {}),
    ...(Object.keys(slots).length ? { slots } : {}),
  };
  await patchBoard(projectId, { sheets: { [id]: entry } });
  setCurrentSheetId(sessionId, id);
  const inner = innerRect({ ...entry });
  // 占地者点名（刀③ 2026-08-30）：铺纸不避家具（纸不渲染，压着文件夹用户什么也
  // 看不见），但**必须说清这块地上已经住着谁** —— proj_mtfpehm3 首拍就是纸铺在
  // 文件夹排上、agent 规划的版位下半截被占，连吃四发拒收却没人告诉它为什么。
  const occupants = membersInRect({ ...board, sheets: board.sheets }, { x: rect.x, y: rect.y, w: rect.w, h: rect.h })
    .map((m) => ({
      id: m.id, folder: !!m.folder,
      local: { x: m.x - inner.x, y: m.y - inner.y }, w: m.w, h: m.h,
      slots: Object.entries(slots)
        .filter(([, sl]) => m.x < inner.x + sl.x + sl.w && m.x + m.w > inner.x + sl.x
          && m.y < inner.y + sl.y + sl.h && m.y + m.h > inner.y + sl.y)
        .map(([nm]) => nm),
    }));
  return {
    id, ...entry, innerW: inner.w, innerH: inner.h,
    basis: rect.basis, overlapsLoose: rect.overlapsLoose, clampedSlots, occupants, trimmed,
  };
}

const DESCRIPTION = `Lay a fresh SHEET on the board and make it the current one — do this before you
start writing (like turning to a clean page). A sheet is one screen of the user's
device at 75% zoom; the machine picks where it goes (the first sheet opens right
under the user's current view; later ones stack below the current sheet).
After this, write_on_board's at:{x,y} means PIXELS from this sheet's top-left
writable corner, and writes without at flow top-to-bottom on it; when a sheet
fills up a new one is opened for you automatically — call open_sheet yourself when
you START A NEW TOPIC/CHAPTER, so each sheet reads as one page about one thing.
The user can drag things off a sheet freely — the sheet constrains you, not them.`;

export function makeOpenSheetTool({ projectId, sessionId, ctx }) {
  return tool('open_sheet', DESCRIPTION, {
    title: z.string().max(60).optional().describe('What this sheet is about (for read_board / your own map, e.g. 第二章 — sheets are invisible to the user)'),
    name: z.string().regex(TAG_RE).optional().describe('Sheet name to refer to it later (ASCII like act2; default auto p1/p2/…)'),
    where: z.enum(['next', 'viewport']).optional()
      .describe("next = below the current sheet (default when sheets exist); viewport = right where the user is looking now (default for the first sheet — also use it to bring work back to the user's eyes)"),
    plan: z.array(SLOT).max(24).optional()
      .describe('PLAN THE WHOLE PAGE HERE, before writing anything: carve the sheet into named blocks (slots) and say what goes in each. Then write_on_board{slot:"main"} drops content into that block. A sheet is WIDE (landscape) — a single column down the left wastes most of it; think in columns and rows.'),
  }, async (args, extra) => {
    if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
    const by = byOf(extra);
    const s = await openSheetFor(projectId, {
      sessionId, by, title: args.title || null, name: args.name || null, where: args.where || null,
      plan: args.plan || null,
    });
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `铺了一张纸 ${s.id}` });
      ctx?.emit?.(Events.boardFocus({ x: s.x, y: s.y, w: s.w, h: s.h }, { layer: '', soft: s.basis !== 'viewport', actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const colCap = capacityOf(DEFAULT_CHALK_W, s.innerH);
    const cols = Math.max(1, Math.floor(s.innerW / (DEFAULT_CHALK_W + SHEET_MARGIN)));
    const lines = [
      `Sheet ${s.id} laid at world (${s.x},${s.y}) ${s.w}x${s.h}${s.title ? ` — “${s.title}”` : ''}; it is now the current sheet.`,
      `Writable area: ${s.innerW}x${s.innerH}px, margin ${SHEET_MARGIN}. at:{x,y} means pixels from its top-left writable corner (x→right, y→down).`,
      // 量纲（刀 D）：agent 手里的东西是字，护栏却全是像素 —— 让它自己换算
      // ＝ 每次落笔前做一道做不准的算术，结果是写完才发现装不下。
      `Scale: ~26px per line, ~${colCap.perLine} CJK chars per ${DEFAULT_CHALK_W}px-wide line. This sheet is ${colCap.lines} lines deep and ${cols} columns wide (≈${colCap.cjk * cols} CJK chars if you use all of it).`,
    ];
    const slotList = Object.entries(s.slots || {});
    if (slotList.length) {
      // 覆盖率（刀 E）：一张横着的纸只画一条竖栏，大半是空的 —— 把这个数直接报出来
      const used = slotList.reduce((n, [, v]) => n + v.w * v.h, 0);
      const pct = Math.round((used / (s.innerW * s.innerH)) * 100);
      lines.push(`Planned ${slotList.length} slots covering ${pct}% of the sheet:`);
      for (const [nm, v] of slotList) {
        const c = capacityOf(v.w, v.h);
        lines.push(`  ${nm}${v.about ? `（${v.about}）` : ''}: at (${v.x},${v.y}) ${v.w}x${v.h} — ~${c.lines} lines, ~${c.cjk} CJK chars`);
      }
      lines.push('write_on_board{slot:"<name>"} drops a note into a block (they stack downward inside it). Content that does not fit is REFUSED, not squeezed — re-plan or split it.');
      if (pct < 45) lines.push(`⚠ ${100 - pct}% of this sheet is unplanned. A landscape sheet holds ${cols} columns side by side — carve more blocks rather than leaving it empty.`);
      if (s.clampedSlots?.length) lines.push(`⚠ Clamped into the sheet (they stuck out): ${s.clampedSlots.join(', ')} — check their at/w/h.`);
    } else {
      lines.push(`No slots planned. Plan the page in one go — open_sheet{plan:[{slot,at,w,h,about}…]} — instead of writing one note at a time and hoping it lands well. This sheet takes ${cols} columns side by side; a single column down the left leaves ${Math.round((1 - 1 / cols) * 100)}% of it empty.`);
    }
    lines.push(s.basis === 'viewport' ? 'Opened under the user’s current view.' : (s.basis === 'below-sheet' ? 'Stacked below the current sheet.' : 'Placed below existing content.'));
    if (s.trimmed) lines.push(`Previous sheet ${s.trimmed.id} was trimmed to its content (${s.trimmed.from}→${s.trimmed.to}px tall) so the pages sit close — its leftover blank is gone, not its content.`);
    // 占地者点名（刀③）：谁在纸上、占了哪块版位、该怎么办 —— 三样一次说清
    if (s.occupants?.length) {
      const named = s.occupants.slice(0, 6).map((o) =>
        `${o.folder ? '📁 ' : ''}${o.id} at local (${Math.round(o.local.x)},${Math.round(o.local.y)}) ${o.w}x${o.h}${o.slots.length ? ` — sits in your slot "${o.slots.join('", "')}"` : ''}`);
      lines.push(`⚠ ${s.occupants.length} item(s) ALREADY LIVE on this sheet's ground (they count against your space):`);
      for (const n of named) lines.push(`   ${n}`);
      if (s.occupants.length > 6) lines.push(`   …and ${s.occupants.length - 6} more (read_board lists them).`);
      lines.push('   Options: plan/re-plan your blocks AROUND them (edit_board replan), move them somewhere'
        + ' deliberate (edit_board move — they may be the user\'s, so keep them visible), or re-open with'
        + ' where:"next" for clean ground. Do NOT just write over them.');
    } else if (s.overlapsLoose) {
      lines.push('⚠ Some loose items already sit in this area — they now read as “on this sheet”; move them (edit_board) if that is wrong.');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}
