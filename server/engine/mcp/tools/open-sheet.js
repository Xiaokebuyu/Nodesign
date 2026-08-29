/**
 * mcp/tools/open-sheet.js —— open_sheet 铺纸（2026-08-29 纸范式刀 2）
 *
 * 开工先铺纸：在画布上登记一块 0.75 倍缩放下等于用户一屏的矩形工作区。
 * 铺在哪由机器定（第一张对准用户此刻的视口 —— 「agent 在用户眼皮底下开工」；
 * 之后缺省铺在当前纸正下方，像往桌上接着铺稿纸）。铺完这张纸就是**当前纸**：
 * write_on_board 的 at 坐标以它的版心左上角为原点，没给 at 的写入在纸内自动
 * 往下排，写满自动翻下一张。
 *
 * 纸是分配纪律不是容器：用户可以把东西拖出纸外，组照旧由 tag/线派生。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { byOf } from '../actor.js';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { fitFor } from '../../../lib/sketch-layout.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import {
  sheetSizeFor, allocateSheetRect, nextSheetName, currentSheet, innerRect, SHEET_MARGIN,
} from '../../../lib/board-sheets.js';
import { setCurrentSheetId, currentSheetIdOf } from '../../../lib/sheet-state.js';
import { Events } from '../../agent/events.js';

/**
 * 铺一张纸并登记（write_on_board 自动铺纸也走这一份 —— 分配纪律只有一份）。
 * @returns {{ id, x, y, w, h, innerW, innerH, basis, overlapsLoose }}
 */
export async function openSheetFor(projectId, {
  sessionId = null, by = 'agent', title = null, name = null, where = null,
} = {}) {
  const board = await readBoard(projectId);
  const vp = getViewpoint(projectId);
  const fit = fitFor(vp);
  const size = sheetSizeFor(fit);
  const cur = currentSheet(board, currentSheetIdOf(sessionId));
  // 缺省：还没有纸（或点名 viewport）→ 对准用户视口；有当前纸 → 铺在它正下方
  const mode = where || (cur ? 'next' : 'viewport');
  const known = new Set(Object.keys(board.zones || {}));
  const obstacles = Object.entries(board.objects || {})
    .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === '')
    .map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
  const rect = allocateSheetRect({
    board, size,
    viewport: mode === 'viewport' && vp?.camera && !vp.layer ? vp.camera : null,
    nearSheet: mode === 'next' && cur ? cur.id : null,
    obstacles,
  });
  const id = (name && TAG_RE.test(name) && !board.sheets?.[name]) ? name : nextSheetName(board);
  const entry = {
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    by, at: new Date().toISOString(), ...(title ? { title } : {}),
  };
  await patchBoard(projectId, { sheets: { [id]: entry } });
  setCurrentSheetId(sessionId, id);
  const inner = innerRect({ ...entry });
  return { id, ...entry, innerW: inner.w, innerH: inner.h, basis: rect.basis, overlapsLoose: rect.overlapsLoose };
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
    title: z.string().max(60).optional().describe('What this sheet is about (shown on the sheet edge, e.g. 第二章)'),
    name: z.string().regex(TAG_RE).optional().describe('Sheet name to refer to it later (ASCII like act2; default auto p1/p2/…)'),
    where: z.enum(['next', 'viewport']).optional()
      .describe("next = below the current sheet (default when sheets exist); viewport = right where the user is looking now (default for the first sheet — also use it to bring work back to the user's eyes)"),
  }, async (args, extra) => {
    if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
    const by = byOf(extra);
    const s = await openSheetFor(projectId, {
      sessionId, by, title: args.title || null, name: args.name || null, where: args.where || null,
    });
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `铺了一张纸 ${s.id}` });
      ctx?.emit?.(Events.boardFocus({ x: s.x, y: s.y, w: s.w, h: s.h }, { layer: '', soft: s.basis !== 'viewport', actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const lines = [
      `Sheet ${s.id} laid at world (${s.x},${s.y}) ${s.w}x${s.h}${s.title ? ` — “${s.title}”` : ''}; it is now the current sheet.`,
      `Writable area: ${s.innerW}x${s.innerH}px, margin ${SHEET_MARGIN}. at:{x,y} in write_on_board now means pixels from its top-left writable corner (x→right, y→down).`,
      s.basis === 'viewport' ? 'Opened under the user’s current view.' : (s.basis === 'below-sheet' ? 'Stacked below the current sheet.' : 'Placed below existing content.'),
    ];
    if (s.overlapsLoose) lines.push('⚠ Some loose items already sit in this area — they now read as “on this sheet”; move them (edit_board) if that is wrong.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}
