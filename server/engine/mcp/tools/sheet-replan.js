/**
 * mcp/tools/sheet-replan.js —— edit_board 的 replan op（2026-08-30 刀⑧，
 * 行数棘轮拆件）。
 *
 * 版位原来只能在 open_sheet 那一刻定，写到一半发现规划错了只能整张重来 ——
 * 「先画格子」得是能修正的动作。按名合并：点名的版位增改，没点名的原样保留；
 * 新声明 for:'artifacts' 时旧的产物位摘牌（一张纸只有一个产物位）。
 */

import { innerRect, currentSheet } from '../../../lib/board-sheets.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { capacityOf } from '../../../lib/sketch-layout.js';
import { clampPlan } from './open-sheet.js';

/**
 * @returns {{ error:string } | { sheetId:string, entry:object, report:string }}
 *   entry = 该纸更新后的完整登记项（调用方放进 sheets patch）
 */
export function applyReplan({ board, sheetsPatch, sessionId, op }) {
  const base = { ...board, sheets: { ...(board.sheets || {}), ...sheetsPatch } };
  const sh = op.sheet && base.sheets?.[op.sheet]
    ? { id: op.sheet, ...base.sheets[op.sheet] }
    : currentSheet(base, currentSheetIdOf(sessionId));
  if (!sh) return { error: '还没有纸 —— 先 open_sheet' };
  const inn = innerRect(sh);
  // prevSlots：below 可以引用纸上已有的版位（「在 main 底下补一块」是最常见的补法）
  const { slots: addSlots, clampedSlots } = clampPlan(op.plan, { w: inn.w, h: inn.h }, base.sheets[sh.id].slots || {});
  const merged = { ...(base.sheets[sh.id].slots || {}) };
  if (Object.values(addSlots).some((sl) => sl.for === 'artifacts')) {
    for (const nm of Object.keys(merged)) {
      if (merged[nm].for === 'artifacts') { merged[nm] = { ...merged[nm] }; delete merged[nm].for; }
    }
  }
  // 属性级合并（2026-08-30）：replan 只想改尺寸时不该把旧的 about / for 一并抹掉
  for (const [nm, sl] of Object.entries(addSlots)) merged[nm] = { ...(merged[nm] || {}), ...sl };
  const names = Object.entries(addSlots).map(([nm, sl]) => {
    const c = capacityOf(sl.w, sl.h);
    return `${nm} at (${sl.x},${sl.y}) ${sl.w}x${sl.h}（~${c.lines} 行 / ~${c.cjk} 字）`;
  });
  return {
    sheetId: sh.id,
    entry: { ...base.sheets[sh.id], slots: merged },
    report: `· replan：纸 ${sh.id} 增改版位 ${names.join('；')}`
      + `${clampedSlots.length ? `；⚠ 钳进版心：${clampedSlots.join(', ')}` : ''}。没点名的版位原样保留。`,
  };
}
