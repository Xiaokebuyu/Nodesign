/**
 * mcp/tools/write-on-board-place.js —— write_on_board 的纸上落位（2026-08-29 纸范式刀 2，
 * 行数棘轮拆件：text 与 sketch 两条路共用同一份落位与返回文案）。
 *
 * 决策树（启发式引擎退役后仅存的分支）：
 *   near+side 显式 → 精确贴放（语义要求；压上如实报）
 *   reply_to      → 接楼正下方（纸满翻页）
 *   at            → 纸内定点（钳进版心，钳了如实报）
 *   什么都没有    → 纸内顺排（纸满翻页）
 * 文件夹层没有纸：线程/贴放照常，否则排在这一层内容底下。
 */

import {
  currentSheet, innerRect, toLocal, placeAtOnSheet, placeThread, placeBeside,
  nextSpotInSheet, overlapIds, sheetOfPoint,
} from '../../../lib/board-sheets.js';
import { currentSheetIdOf, setCurrentSheetId } from '../../../lib/sheet-state.js';
import { UNIT } from '../../../lib/rect.js';
import { openSheetFor } from './open-sheet.js';

export function makeSheetPlacer({ projectId, sessionId, by }) {
  /** 根层：纸上落位。返回 {x,y,resolution,sheetId,opened,clamped,pressed} */
  const placeOnSheets = async (b, { box, at, sheetName, replyRect, anchorRect, side, obstacles }) => {
    let sheets = b.sheets || {};
    let opened = null;
    const pick = () => {
      if (sheetName && sheets[sheetName]) return { id: sheetName, ...sheets[sheetName] };
      return currentSheet({ sheets }, currentSheetIdOf(sessionId));
    };
    const openNext = async (near) => {
      opened = await openSheetFor(projectId, { sessionId, by, where: near ? 'next' : null });
      sheets = { ...sheets, [opened.id]: { x: opened.x, y: opened.y, w: opened.w, h: opened.h, at: opened.at, by: opened.by } };
      return { id: opened.id, ...sheets[opened.id] };
    };
    const bWith = () => ({ ...b, sheets });
    const done = (p, resolution, sheetId, clamped = false) => {
      if (sheetId) setCurrentSheetId(sessionId, sheetId);
      const pressed = overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h }, obstacles);
      return {
        x: Math.round(p.x), y: Math.round(p.y), resolution, sheetId, opened, clamped, pressed,
        overflowY: p.overflowY || 0,   // 纸从那个 y 往下不够高还差多少（换纸判据）
      };
    };
    const sheetOf = (p) => {
      const hit = sheetOfPoint(bWith(), { x: p.x + box.w / 2, y: p.y + box.h / 2 });
      return hit ? hit.id : null;
    };

    // 显式贴放（near + side）：语义要求（题注在上方）的精确几何，不搜索
    if (anchorRect && side) {
      const p = placeBeside(anchorRect, box, side, UNIT);
      return done(p, `beside-${side}`, sheetOf(p));
    }
    // 线程：正下方，纸满翻页
    if (replyRect) {
      const p = placeThread(bWith(), replyRect, box, { obstacles });
      if (!p.sheetFull) return done(p, 'thread', p.sheetId);
      const ns = await openNext(p.sheetFull);
      const inner = innerRect(ns);
      return done({ x: inner.x, y: inner.y }, 'thread-new-sheet', ns.id);
    }
    // 定点 / 顺排：都要有一张纸
    let s = pick();
    if (!s) s = await openNext(null);
    if (at) {
      const p = placeAtOnSheet(s, at, box);
      return done(p, 'at', s.id, p.clamped);
    }
    const flow = nextSpotInSheet(bWith(), s.id, box);
    if (flow) return done(flow, 'flow', s.id);
    const ns = await openNext(s.id);
    const inner2 = innerRect(ns);
    return done({ x: inner2.x, y: inner2.y }, 'flow-new-sheet', ns.id);
  };

  /** 文件夹层落位（没有纸）：线程/贴放照常，否则排在这一层内容底下 */
  const placeInZone = ({ box, replyRect, anchorRect, side, obstacles }) => {
    if (replyRect) {
      const p = placeThread({ sheets: {} }, replyRect, box, { obstacles });
      return { x: p.x, y: p.y, resolution: 'thread', pressed: [] };
    }
    if (anchorRect) {
      const p = placeBeside(anchorRect, box, side || 'below', UNIT);
      return { x: p.x, y: p.y, resolution: `beside-${side || 'below'}`, pressed: overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h }, obstacles) };
    }
    const left = obstacles.length ? Math.min(...obstacles.map(o => o.x)) : 10;
    const bottom = obstacles.reduce((m, o) => Math.max(m, o.y + o.h), 0);
    return { x: Math.round(left), y: Math.round(bottom) + 40, resolution: 'below-content', pressed: [] };
  };

  /** 返回文案：从真实落点生成（"工具返回不许撒谎"—— 08-25 陷阱③ 的纪律不变） */
  const describeSpot = (b, placed) => {
    const bits = [];
    if (placed.sheetId && b.sheets?.[placed.sheetId]) {
      const s = { id: placed.sheetId, ...b.sheets[placed.sheetId] };
      const l = toLocal(s, placed);
      bits.push(`on sheet ${s.id}${s.title ? `（${s.title}）` : ''} at local (${Math.round(l.x)},${Math.round(l.y)})`);
    }
    if (placed.resolution === 'thread') bits.push('under the note it replies to (thread)');
    else if (placed.resolution === 'thread-new-sheet') bits.push('the thread filled its sheet — turned the page (new sheet)');
    else if (placed.resolution === 'flow') bits.push('flowed below the last item');
    else if (placed.resolution === 'flow-new-sheet') bits.push('sheet was full — turned the page (new sheet)');
    else if (placed.resolution === 'at') {
      // 换纸判据（08-29 刀 C）：光说"钳住了"不够 —— 钳住的结果是这条被压到贴着
      // 纸底、跟上一条挤在一起，而 agent 不知道该翻页了。
      bits.push(placed.overflowY
        ? `at your spot but this sheet RAN OUT below that y (short by ${placed.overflowY}px) — it was pushed up to fit. Turn the page (open_sheet) or write it shorter`
        : (placed.clamped ? 'at your spot, CLAMPED into the sheet (it stuck out)' : 'exactly where you asked'));
    }
    else if (placed.resolution?.startsWith('beside-')) bits.push(`${placed.resolution.slice(7)} of the anchor (exact — no auto-nudging)`);
    else if (placed.resolution === 'lane-open') bits.push('at the head of its fresh sheet');
    else if (placed.resolution === 'below-content') bits.push('below current content (folder layer has no sheets)');
    if (placed.opened) bits.push(`opened sheet ${placed.opened.id} (${placed.opened.innerW}x${placed.opened.innerH} writable)`);
    if (placed.pressed?.length) bits.push(`⚠ overlaps ${placed.pressed.slice(0, 4).join(', ')} — move yours (edit_board) if unintended`);
    return bits.join('; ');
  };

  return { placeOnSheets, placeInZone, describeSpot };
}
