/**
 * mcp/tools/sheet-replan.js —— edit_board 的 replan op（2026-08-30 刀⑧，
 * 行数棘轮拆件）。
 *
 * 版位原来只能在 open_sheet 那一刻定，写到一半发现规划错了只能整张重来 ——
 * 「先画格子」得是能修正的动作。按名合并：点名的版位增改，没点名的原样保留；
 * 新声明 for:'artifacts' 时旧的产物位摘牌（一张纸只有一个产物位）。
 *
 * ## 2026-09-01 册：改的是这一页还是整摞
 *
 * 版式现在有两层（摞的默认 + 这一页的覆盖，见 board-sheets.js 的 slotsOf）。
 * `scope:'stack'` 改整摞，缺省只改这一页。
 *
 * ⭐ 改这一页时**只存它真的动过的那几块**，不把继承来的那一整份抄到纸上 ——
 * 抄下来的话这一页就有了自己的全套覆盖，以后改摞的版式再也传不到它身上，
 * 而那正是「册」这件事要的东西。
 */

import { innerRect, currentSheet, resolveSheet, slotsOf } from '../../../lib/board-sheets.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { capacityOf } from '../../../lib/sketch-layout.js';
import { clampPlan } from './open-sheet.js';

/**
 * @returns {{ error:string } | { sheetId, entry, report } | { pile, pileSlots, report }}
 *   entry    = 该纸更新后的完整登记项（调用方放进 sheets patch）
 *   pileSlots = 整摞的新版式（scope:'stack' 时；调用方放进 stacks patch）
 */
export function applyReplan({ board, sheetsPatch, sessionId, op }) {
  const base = { ...board, sheets: { ...(board.sheets || {}), ...sheetsPatch } };
  const sh = op.sheet && base.sheets?.[op.sheet]
    ? resolveSheet(base, op.sheet)
    : currentSheet(base, currentSheetIdOf(sessionId));
  if (!sh) return { error: '还没有纸 —— 先 open_sheet' };
  const inn = innerRect(sh);
  const toPile = op.scope === 'stack';
  const pile = sh.stack || sh.id;
  /** 这一层现在有什么（改整摞看摞的，改这一页看这一页自己的覆盖） */
  const own = (toPile ? base.stacks?.[pile]?.slots : base.sheets[sh.id].slots) || {};
  /**
   * `below` 要能引用**此刻生效**的版位（「在 main 底下补一块」是最常见的补法），
   * 而 main 可能是继承来的、不在 own 里。所以 prevSlots 给合并后的那一份，
   * 落盘只落 own + 这次动过的。
   */
  const { slots: addSlots, clampedSlots } = clampPlan(op.plan, { w: inn.w, h: inn.h }, slotsOf(base, sh));
  const merged = { ...own };
  if (Object.values(addSlots).some((sl) => sl.for === 'artifacts')) {
    for (const nm of Object.keys(merged)) {
      if (merged[nm].for === 'artifacts') { merged[nm] = { ...merged[nm] }; delete merged[nm].for; }
    }
  }
  // 属性级合并（2026-08-30）：replan 只想改尺寸时不该把旧的 about / for 一并抹掉。
  // 底子取「此刻生效的那一份」—— 改一块继承来的版位时，about/for 也该留住
  const live = slotsOf(base, sh);
  for (const [nm, sl] of Object.entries(addSlots)) merged[nm] = { ...(merged[nm] || live[nm] || {}), ...sl };
  const names = Object.entries(addSlots).map(([nm, sl]) => {
    const c = capacityOf(sl.w, sl.h);
    // ⚠️ 用户亲手调过的那一块，改了要如实报 —— 「别跟用户拔河」这条规矩要成立，
    // 前提是 agent 知道自己刚覆盖了他的手（同 objects 的 seat:'user' 那套报法）
    const touched = live[nm]?.by === 'user' ? '（⚠ 这块是用户亲手调的，已被你改掉）' : '';
    return `${nm} at (${sl.x},${sl.y}) ${sl.w}x${sl.h}（~${c.lines} 行 / ~${c.cjk} 字）${touched}`;
  });
  const where = toPile ? `整摞「${pile}」的版式` : `纸 ${sh.id}`;
  const tail = `${clampedSlots.length ? `；⚠ 钳进版心：${clampedSlots.join(', ')}` : ''}。没点名的版位原样保留。`
    + (toPile ? '之后叠上去的每一页都用这一版。' : `（只改这一页；要改整摞加 scope:"stack"）`);
  const report = `· replan：${where} 增改版位 ${names.join('；')}${tail}`;
  return toPile
    ? { pile, pileSlots: merged, report }
    : { sheetId: sh.id, entry: { ...base.sheets[sh.id], slots: merged }, report };
}
