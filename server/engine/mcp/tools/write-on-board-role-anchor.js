/**
 * mcp/tools/write-on-board-role-anchor.js —— 角色板书的缺省锚（2026-08-28；棘轮拆件）
 *
 * 角色不带任何落位线索（reply_to/near/at/open_lane）时，机器替它选锚。两级：
 *
 * 1. **角色专线**（预制摆位，用户拍板）：GM 用 open_lane 以角色名（slug 或展示名）
 *    开过线 → 自动续进自己的线（reply_to 线内最新一条 + tag 着线）。摆位和延伸
 *    方向是 GM 预制的，角色的工作退化成「补台词」。
 * 2. **rounds 本拍锚定**（摆位直觉版，前身"桌位表"退役）：轮次场里无线索 = 在
 *    回应本拍 → reply_to 最新一条旁白板书，台词经侧挂直觉落到旁白身侧 ——
 *    「章节竖列、每拍横排」从回应语义里自己长出来，不硬编格式。
 *
 * 角色明确给了落位（比如回用户落痕那条）时它的手优先，这里不抢。
 */
import { CHALK_DIR } from '../../../lib/chalk.js';
import { listRoleNames } from '../../agent/role-card.js';
import { getScene } from '../../agent/scene.js';

/**
 * @returns {Promise<{replyTo: string|null, tag: string|null}>}
 *   replyTo 非空 = 用它当缺省锚；tag 非空 = 这条板书顺带着线的 tag（仅专线路径给）。
 */
export async function roleDefaultAnchor({ board, by, projectId, sharedRoot }) {
  // 专线优先
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
  // rounds 本拍
  if (getScene(projectId)?.mode === 'rounds') {
    const beats = Object.entries(board.objects)
      .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x) && (e.by || 'agent') === 'agent')
      .map(([id]) => id).sort();   // 板书文件名以时间戳开头，路径序即时间序
    if (beats.length) return { replyTo: beats[beats.length - 1], tag: null };
  }
  return { replyTo: null, tag: null };
}
