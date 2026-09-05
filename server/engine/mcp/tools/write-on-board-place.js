/**
 * mcp/tools/write-on-board-place.js —— write_on_board 的落位与返回文案
 * （2026-09-05 意图层重写；此前是纸范式的三分支落位器）
 *
 * 决策树只剩关系：
 *   reply_to / chain     → 接楼（正下方，被挡就跳到挡它的东西底下）
 *   place.with           → 续同一组（组尾正下方）
 *   place.by / near      → 贴着锚（side 是偏好；放不下换侧、滑开、螺旋找最近空位）
 *   什么都没有           → 用户视口的空地；没有视口就排在内容底下
 * 文件夹层同一套，只是障碍集换成那一层的。永远不拒收，永远不报像素。
 */
import { solvePlace, placeBelow, overlapIds, describePlacement } from '../../../lib/board-place.js';

/** 这个矩形在用户视口里吗（报文里那句 "Visible in the user's viewport"） */
const visibleIn = (rect, vpRect) => !!vpRect && !(rect.x + rect.w < vpRect.x || vpRect.x + vpRect.w < rect.x
  || rect.y + rect.h < vpRect.y || vpRect.y + vpRect.h < rect.y);

export function makePlacer() {
  /**
   * @returns {{x,y,how,side,nudged,wanted,pressed:string[]}}
   */
  const placeNote = (b, { box, anchorRect = null, side = null, groupRect = null, replyRect = null, obstacles = [], vpRect = null, column = false }) => {
    let placed;
    if (replyRect) {
      const p = placeBelow(replyRect, box, obstacles);
      placed = { ...p, how: 'thread', side: 'below', nudged: false, wanted: null };
    } else {
      placed = solvePlace({ box, anchor: anchorRect, side, group: groupRect, viewport: vpRect, obstacles, column });
    }
    const pressed = overlapIds({ x: placed.x, y: placed.y, w: box.w, h: box.h }, obstacles);
    return { ...placed, x: Math.round(placed.x), y: Math.round(placed.y), pressed };
  };

  /** 返回文案：从真实落点生成（"工具返回不许撒谎"—— 08-25 陷阱③ 的纪律不变） */
  const describeSpot = (placed, { anchorId = null, groupTag = null } = {}) => {
    const bits = [describePlacement(placed, { anchorId, groupTag })];
    if (placed.pressed?.length) bits.push(`⚠ overlaps ${placed.pressed.slice(0, 4).join(', ')} — move yours (edit_board) if unintended`);
    return bits.join('; ');
  };

  /** 板书写完那一段返回文案 */
  const describeChalkWrite = ({ rel, rect, board, placed, box, args, vpRect, parentId, anchorId, laneFrom, boardBefore, groupTag = null }) => {
    const lines = [
      `Wrote board note ${rel} — ${describeSpot(placed, { anchorId, groupTag })}.`,
      `Visible in the user's viewport: ${visibleIn(rect, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
    ];
    // 折叠如实报：卡高封顶到 CARD_MAX_H，超出的折在卡里
    if (box.capped) {
      lines.push(`⚠ Long for one card: it shows the first ~${box.h}px, the rest is folded (the reader clicks to unfold). A board note explains one thing — if this is real content, it belongs in an artifact (docx / site / deck); if it is several points, write several notes.`);
    }
    // 收卷提醒（2026-08-27 收纳器）：落进收着的组 = 用户看不见这条新话
    {
      const rolledInto = [args.tag, boardBefore.objects?.[parentId]?.tag, boardBefore.objects?.[anchorId]?.tag]
        .find(t => t && board.rolls?.[t]);
      if (rolledInto) lines.push(`⚠ #${rolledInto} 这条线收着卷（用户看不见里面）——这条也进了卷。要让用户看见，先 edit_board unroll{tag:"${rolledInto}"}。`);
    }
    if (laneFrom) {
      lines.push(`Opened lane #${args.tag}${laneFrom !== 'fresh' ? ` branching from ${laneFrom.id}` : ''}`
        + ` — continue it with {tag:"${args.tag}", chain:true}; read_board lists lanes.`);
    }
    lines.push('The user can annotate it to reply; answer with reply_to (or chain:true on the same tag).');
    return lines;
  };

  return { placeNote, describeSpot, describeChalkWrite, visibleIn };
}
