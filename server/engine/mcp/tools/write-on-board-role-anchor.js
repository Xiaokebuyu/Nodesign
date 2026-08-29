/**
 * mcp/tools/write-on-board-role-anchor.js —— 角色板书的缺省锚（2026-08-28；08-29 泛化成「这一拍」）
 *
 * 角色不带任何落位线索（reply_to/near/at/open_lane）时，机器替它选锚。两级：
 *
 * 1. **属于它的那条线**（预制摆位，用户拍板）：主持人用 open_lane 以角色名（slug 或
 *    展示名）开过线 → 自动接在自己那条线上（reply_to 线内最新一条 + 着线的 tag）。
 *    摆位和延伸方向是主持人预制的，角色的工作退化成「补一段话」。
 * 2. **这一拍**（08-29）：角色没有专属线时，它这一段就是在回应**主持人最新写的那一条**
 *    —— reply_to 它，再经侧挂直觉落到它身侧。「章节竖着走、同一拍的几个人横着排」
 *    是从「在回应谁」这个语义里自己长出来的，不硬编版式。
 *
 *    08-28 时这一级只在 rounds 模式下开；模式概念 08-29 整个退役（谁接这一拍由主持人
 *    每拍决定，不再是一个服务端状态），所以这一级对所有角色一律成立。
 *
 * 角色明确给了落位（比如回用户那条）时它的手优先，这里不抢。
 */
import { CHALK_DIR } from '../../../lib/chalk.js';
import { listRoleNames } from '../../agent/role-card.js';

/**
 * @returns {Promise<{replyTo: string|null, tag: string|null}>}
 *   replyTo 非空 = 用它当缺省锚；tag 非空 = 这条板书顺带着线的 tag（仅专属线路径给）。
 */
export async function roleDefaultAnchor({ board, by, sharedRoot }) {
  // 属于它的那条线优先
  if (board.lanes) {
    let laneTag = board.lanes[by] ? by : null;
    if (!laneTag) {
      try {
        const nm = (await listRoleNames(sharedRoot)).get(by);
        if (nm && board.lanes[nm]) laneTag = nm;
      } catch { /* 展示名查不到就只认 slug 线 */ }
    }
    if (laneTag) {
      const inLane = Object.entries(board.objects)
        .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x) && e.tag === laneTag)
        .map(([id]) => id).sort();
      if (inLane.length) return { replyTo: inLane[inLane.length - 1], tag: laneTag };
    }
  }
  // 这一拍 = 主持人最新写的那一条
  const beats = Object.entries(board.objects)
    .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x) && (e.by || 'agent') === 'agent')
    .map(([id]) => id).sort();   // 板书文件名以时间戳开头，路径序即时间序
  if (beats.length) return { replyTo: beats[beats.length - 1], tag: null };
  return { replyTo: null, tag: null };
}
