/**
 * server/lib/board-place.js —— 落位三动词（2026-09-01 从 board-sheets 拆出，行数棘轮）
 *
 * 旧引擎（环搜 / 挑侧 / 半平面 / 走廊 / 兜底左缘）2026-08-29 整层退役 —— ㉚ 五刀证明
 * 那一层的坑修不完，且 agent 对「纸内绝对坐标」的适应性远好于「模糊锚点」。留下的
 * 规则每条都短到不需要启发式，三个动词就是全部。
 *
 * 拆出来是因为 board-sheets 顶到了 620（册那一批加了版式两层的解析）。切口挑这里，
 * 是因为这三个是**纯几何**：给矩形出矩形，不认识摞、不认识版式、不读 objects。
 */

import { UNIT, overlaps } from './rect.js';
import { innerRect, toWorld, sheetOfPoint } from './board-sheets.js';

/* ── 落位三动词（2026-08-29 刀 2：启发式引擎退役后仅存的三条几何规则）──
 *
 * 旧引擎（环搜/挑侧/半平面/走廊/兜底左缘）整层退役 —— ㉚ 五刀证明那一层的坑
 * 修不完，且 agent 对「纸内绝对坐标」的适应性远好于「模糊锚点」。留下的规则
 * 每条都短到不需要启发式：
 *   placeAtOnSheet  agent 说了算（钳进版心，钳了如实报）
 *   placeThread     接楼只有一个方向：正下方，压住就跳到那件底下
 *   placeBeside     贴放是精确几何不是搜索（压上如实报，不代找洞）
 */

/**
 * 纸内定点：局部坐标 → 世界坐标，钳进版心。钳过要如实报（越界钳住但要说）。
 *
 * `overflowY` = 从 agent 要的那个 y 往下**真的不够高**还差多少（2026-08-29 刀 C）。
 * 站主定的换纸判据第一条就是"当前这块地放不下剩下一整块内容"—— 光说"钳住了"
 * 不够，钳住的结果是那条被压到贴着纸底、跟上一条挤在一起，而 agent 完全不知道
 * 该翻页了。
 */
export function placeAtOnSheet(s, at, box) {
  const inner = innerRect(s);
  const ideal = toWorld(s, { x: Math.round(at.x), y: Math.round(at.y) });
  const x = Math.min(Math.max(ideal.x, inner.x), Math.max(inner.x, inner.x + inner.w - box.w));
  const y = Math.min(Math.max(ideal.y, inner.y), Math.max(inner.y, inner.y + inner.h - box.h));
  return {
    x: Math.round(x), y: Math.round(y),
    clamped: x !== ideal.x || y !== ideal.y,
    overflowY: Math.max(0, Math.round(ideal.y + box.h - (inner.y + inner.h))),
  };
}

/**
 * 接楼（线程）：被回应那条的正下方；位置被占就跳到占位者底下接着试。
 * 只往下 —— 读序即方向。落点出了所在纸的版心底 → 报 sheetFull（调用方翻纸）。
 * 纸外（文件夹层/散地）没有纸界，滑到空为止。
 */
export function placeThread(board, replyRect, box, { obstacles = [], gap = UNIT, own = null } = {}) {
  // own = 被回应那条自己认领的纸。一摞纸叠在一起时，"接在它下面"接的是**它那一页**，
  // 不是这块地上最新的那一页（2026-09-01 叠纸刀 1）
  const sheet = sheetOfPoint(board, { x: replyRect.x + replyRect.w / 2, y: replyRect.y + replyRect.h / 2 }, own);
  const floor = sheet ? innerRect(sheet).y + innerRect(sheet).h : Infinity;
  const x = Math.round(replyRect.x);
  let y = replyRect.y + replyRect.h + gap;
  for (let i = 0; i < 500; i += 1) {
    if (y + box.h > floor) return { sheetFull: sheet.id };
    const r = { x, y, w: box.w, h: box.h };
    const hit = obstacles.find((o) => overlaps(r, o));
    if (!hit) return { x, y: Math.round(y), sheetId: sheet?.id || null };
    y = hit.y + hit.h + gap;
  }
  return { x, y: Math.round(y), sheetId: sheet?.id || null };
}

/** 贴放：锚点某一侧的精确位置（gap 像素）。不搜索 —— 压上由调用方如实报。 */
export function placeBeside(anchor, box, side = 'right', gap = UNIT) {
  const p = side === 'right' ? { x: anchor.x + anchor.w + gap, y: anchor.y }
    : side === 'left' ? { x: anchor.x - gap - box.w, y: anchor.y }
      : side === 'below' ? { x: anchor.x, y: anchor.y + anchor.h + gap }
        : { x: anchor.x, y: anchor.y - gap - box.h };
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
