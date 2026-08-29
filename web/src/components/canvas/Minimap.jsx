import { useRef, useState } from 'react';
import { CANVAS, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { viewportWorldBox, boxUnion } from '../../lib/board-camera.js';
import { GAP } from '../../lib/theme.js';

/**
 * Minimap —— 无限画布的导航小地图（2026-08-13）
 *
 * ## 它替掉的是什么
 *
 * 画布本来有一对"整理 / 工作"双视图：整理看全景、工作锁定一块区。用户拍板
 * 之后**总览不再是一种视图，而是一个导航控件** —— 全貌用它看，干活始终在
 * 当前这一层。这条决定顺带拆掉了两样东西：`viewMode` 的双模式，以及文件夹
 * 的"摊开 / 收起"两态（那是为了在总览里塞下所有内容才需要的）。
 *
 * ## 数学是现成的
 *
 * `board-camera.js` 已经定好 `screen = (world + cam) * z`，还给了
 * `viewportWorldBox`（当前视口对应的世界矩形）和 `bounds`（可漫游范围 =
 * 内容外沿再放宽一整屏）。小地图只是**同一套数学的第二个消费者**：把
 * `bounds` 等比缩进一个角上的框，再把视口那块画成一个亮框。
 *
 * 所以这里不该出现任何新的坐标约定 —— 出现了就说明有人在这儿又推了一遍。
 *
 * ## 交互
 *
 * 两种手势，按下的位置决定是哪一种（2026-08-13 加的第二种）：
 *
 *   - 按在**视窗框里** → 抓着这个框走。镜头位移 = 框的位移，按下那一刻的
 *     抓点偏移全程保持。这是用户要的那种手感："拖动小地图里面的视窗来移动镜头"。
 *   - 按在**框外** → 把那一点挪到视口中心，然后接着拖（老行为）。
 *
 * 区别只在**偏移**：抓框是 `目标中心 = 光标 − 抓点偏移`，点别处是
 * `目标中心 = 光标`。所以两条路共用一个 `moveTo`，按下时记一次偏移就够了。
 *
 * **不做缩放**：小地图是"我现在在哪、别的东西在哪边"，不是第二套镜头控制。
 */

export const MAP_W = 168;
export const MAP_H = 116;
const PAD = 6;

/** 世界矩形 → 小地图内像素。等比缩 + 居中，不拉伸（拉伸的地图会骗人） */
export function projector(bounds) {
  const bw = Math.max(1, bounds.w);
  const bh = Math.max(1, bounds.h);
  const k = Math.min((MAP_W - PAD * 2) / bw, (MAP_H - PAD * 2) / bh);
  const ox = (MAP_W - bw * k) / 2;
  const oy = (MAP_H - bh * k) / 2;
  return {
    k,
    toMap: (x, y) => ({ x: ox + (x - bounds.x) * k, y: oy + (y - bounds.y) * k }),
    toWorld: (mx, my) => ({ x: (mx - ox) / k + bounds.x, y: (my - oy) / k + bounds.y }),
  };
}

export default function Minimap({ bounds, cam, viewport, items = [], onJump }) {
  const hostRef = useRef(null);
  const draggingRef = useRef(false);
  // 抓点偏移（小地图像素）：抓框时 = 光标 − 框心，点别处时 = 0。
  // 记在 ref 上而不是 state：它每一帧都要读，但一次都不该触发重渲染。
  const grabRef = useRef({ x: 0, y: 0 });
  const [onView, setOnView] = useState(false);

  if (!bounds || !viewport?.w) return null;
  const view = viewportWorldBox(cam, viewport);
  // 相机 2026-08-13 起是自由的（不再被内容边界夹住），视口可以跑到内容圈外。
  // 投影范围取「内容 ∪ 视口」：视口框永远画在图内 —— 跑得再远，小地图上也
  // 看得见自己和内容各在哪边，点一下就能回去。这正是撤掉硬边界的兜底。
  const p = projector(boxUnion([bounds, view]) || bounds);
  const vTL = p.toMap(view.x, view.y);
  const vW = Math.max(6, view.w * p.k);
  const vH = Math.max(6, view.h * p.k);

  /** 光标在小地图里的像素坐标 */
  const mapPt = (e) => {
    const r = hostRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** 按下的点是不是落在视窗框里（框本身 pointerEvents:none，命中只能算几何） */
  const inView = (m) => m.x >= vTL.x && m.x <= vTL.x + vW && m.y >= vTL.y && m.y <= vTL.y + vH;

  /** 把「光标 − 抓点偏移」那一点挪到视口中心 */
  const moveTo = (e) => {
    if (!hostRef.current || !onJump) return;
    const m = mapPt(e);
    onJump(p.toWorld(m.x - grabRef.current.x, m.y - grabRef.current.y));
  };

  return (
    <div
      ref={hostRef}
      // 小地图自己吃掉手势：不这么做的话按下去会穿透到画布上变成平移
      onPointerDown={(e) => {
        e.stopPropagation();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const m = mapPt(e);
        // 抓框：偏移 = 光标 − 框心，于是框跟着手走而不是"跳到手底下"。
        // 点别处：偏移归零 = 那一点居中（老行为）。
        grabRef.current = inView(m)
          ? { x: m.x - (vTL.x + vW / 2), y: m.y - (vTL.y + vH / 2) }
          : { x: 0, y: 0 };
        moveTo(e);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) { moveTo(e); return; }
        const hit = inView(mapPt(e));
        if (hit !== onView) setOnView(hit);        // 只在跨边界时写 state
      }}
      onPointerLeave={() => { if (!draggingRef.current) setOnView(false); }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => { draggingRef.current = false; }}
      title="拖视窗框 = 移镜头 · 点别处跳过去"
      style={{
        position: 'absolute', left: GAP.md, bottom: GAP.md, zIndex: 40,
        width: MAP_W, height: MAP_H,
        background: PAPER.paper,
        boxShadow: PAPER_SHADOW.far,
        cursor: draggingRef.current && onView ? 'grabbing' : (onView ? 'grab' : 'pointer'),
        touchAction: 'none', userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* 内容：一件东西一个小方块。**不画标题也不画图标** —— 这个尺寸下
          任何字都是噪点，能看出"东西聚在哪一片"就够了。 */}
      {items.map((it) => {
        const a = p.toMap(it.x, it.y);
        return (
          <div key={it.id} style={{
            position: 'absolute',
            left: a.x, top: a.y,
            width: Math.max(2, it.w * p.k), height: Math.max(2, it.h * p.k),
            background: it.folder ? 'rgba(43,33,23,0.10)' : PAPER.pencil,
            opacity: it.folder ? 1 : 0.75,
            ...(it.folder ? { outline: `1px solid ${PAPER.hair}` } : null),
          }} />
        );
      })}

      {/* 当前视口。画成"亮框"而不是"暗遮罩" —— 遮罩会把小地图变成一块深色，
          而它就贴在画布左下角，深色块比一个细框抢眼得多。 */}
      <div style={{
        position: 'absolute',
        left: vTL.x, top: vTL.y,
        width: Math.max(6, view.w * p.k), height: Math.max(6, view.h * p.k),
        border: '1.5px solid rgba(176,140,79,0.95)',
        background: alpha(CANVAS.brass, 0.10),
        pointerEvents: 'none',
      }} />
    </div>
  );
}
