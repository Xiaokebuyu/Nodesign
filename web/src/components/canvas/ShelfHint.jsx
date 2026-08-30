/**
 * 暂存架的视觉暗示（2026-08-30）。
 *
 * 机器到货不再挤进 agent 的纸面，一律码在架上（服务端 lib/board-shelf.js，
 * seat:'shelf'）。架本身不是一个存起来的东西 —— 这里按「谁还在架上」的包络
 * 画一圈铅笔虚线加一行小字，让用户一眼分清「摆好的版面」和「还没归置的到货」。
 * 东西被 agent/用户挪走（seat 改写）圈就自己缩小、清空即消失，没有第二份状态。
 *
 * 画在世界层、pointer-events:none、压在卡片下面 —— 它是桌面上的一道粉笔记号，
 * 不是一个可交互组件。
 */
import { P, PAPER } from '../../lib/paper.js';
import { sizeOf } from '../../lib/board-kinds.js';

const PAD = 14;

export default function ShelfHint({ positioned }) {
  const items = (positioned || []).filter(o => o?.pos?.seat === 'shelf');
  if (!items.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const it of items) {
    const w = Number.isFinite(it.pos.w) ? it.pos.w : sizeOf(it).w;
    const h = Number.isFinite(it.pos.h) ? it.pos.h : sizeOf(it).h;
    x0 = Math.min(x0, it.pos.x); y0 = Math.min(y0, it.pos.y);
    x1 = Math.max(x1, it.pos.x + w); y1 = Math.max(y1, it.pos.y + h);
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: x0 - PAD,
        top: y0 - PAD - 20,
        width: x1 - x0 + PAD * 2,
        height: y1 - y0 + PAD * 2 + 20,
        border: `1.5px dashed ${P('pencil', 0.55)}`,
        borderRadius: 10,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <div style={{ position: 'absolute', top: 3, left: 10, fontSize: 12, lineHeight: '16px', color: PAPER.pencil, userSelect: 'none' }}>
        暂存 · 还没归置（{items.length}）
      </div>
    </div>
  );
}
