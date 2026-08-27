/**
 * 长按框选（2026-08-17 从 BoardCanvas 拆出 —— 行数棘轮）。
 *
 * 状态（框本身、长按候选）连同三个手势口一起住这儿：它们除了彼此谁也不认识，
 * 留在组件里只是三个 ref 加一个 state 在两千行中间飘着。
 */
import { useRef, useState } from 'react';
import { onChrome, onObject } from '../../lib/board-hit.js';
import { rectsHit } from '../../lib/board-geometry.js';
import { sizeOf } from '../../lib/board-kinds.js';

/**
 * @param {object} p
 * @param {object} p.camera          相机 API（要 toWorld / onPointerUp）
 * @param {object} p.paneRef         视口元素 ref
 * @param {object} p.toolRef         当前工具 ref（只有指针工具才起框选）
 * @param {object} p.positionedRef   这一层的物件（框住谁算谁）
 * @param {object} p.folderViewRef   这一层的文件夹卡
 * @param {Function} p.setSelectedIds
 * @param {object} p.recentDragMovedRef 框完这一下不是点击，别让它把选中清掉
 */
export function useMarquee({
  camera, paneRef, toolRef, positionedRef, folderViewRef, setSelectedIds,
  recentDragMovedRef,
}) {
  /** 框本身：{ a:{x,y}, b:{x,y} }（世界坐标）。null = 没在框 */
  const [marquee, setMarquee] = useState(null);
  const marqueeRef = useRef(null);
  /** 长按候选：{ timer, startX, startY, pointerId } */
  const pressRef = useRef(null);

  // ── 框选（长按起手）────────────────────────────────────────────────
  //
  // 「选中指针控件的时候能够长按拖动以大范围框选」（用户 2026-08-13）。
  //
  // **长按**而不是直接拖：空白处拖拽这个手势已经归相机平移了，那是画布上用得
  // 最多的动作，不能抢。所以按住不动 LONG_PRESS_MS 才转框选 —— 这期间手一动
  // （>4px）就当平移，定时器作废。
  //
  // 转框选的那一下必须**把已经武装的相机平移撤掉**，不然一次手势同时拉框和推
  // 镜头：框的起点钉在世界坐标上，镜头一跑，框看着就往反方向歪。
  const LONG_PRESS_MS = 220;
  /** 比这更小的框算"点了一下空地"（清空选中），不算框选 */
  const MARQUEE_MIN = 6;

  const armMarquee = (e) => {
    if (toolRef.current !== 'select' || e.button !== 0) return;
    if (onChrome(e)) return;
    // onObject 而不是裸 selector：未武装的板书算空地（board-hit 的 chalk-idle 判据），
    // 在它上面长按框选照常起
    if (onObject(e) || e.target.closest?.('[data-transform-handle]')) return;
    clearTimeout(pressRef.current?.timer);
    const sx = e.clientX; const sy = e.clientY;
    const { pointerId } = e;
    pressRef.current = {
      startX: sx, startY: sy, pointerId,
      timer: setTimeout(() => {
        camera.onPointerUp({ pointerId });         // 撤掉这一下已武装的平移
        const r = paneRef.current?.getBoundingClientRect();
        const w = camera.toWorld(sx, sy);
        const a = { sx: sx - (r?.left || 0), sy: sy - (r?.top || 0), wx: w.x, wy: w.y };
        marqueeRef.current = { a, b: a };
        setMarquee({ a, b: a });
      }, LONG_PRESS_MS),
    };
  };

  const moveMarquee = (e) => {
    const p = pressRef.current;
    if (p && !marqueeRef.current) {
      if (Math.abs(e.clientX - p.startX) + Math.abs(e.clientY - p.startY) > 4) {
        clearTimeout(p.timer); pressRef.current = null;    // 手动了 = 这是平移
      }
      return false;
    }
    const m = marqueeRef.current;
    if (!m) return false;
    const r = paneRef.current?.getBoundingClientRect();
    const w = camera.toWorld(e.clientX, e.clientY);
    const b = { sx: e.clientX - (r?.left || 0), sy: e.clientY - (r?.top || 0), wx: w.x, wy: w.y };
    marqueeRef.current = { ...m, b };
    setMarquee({ ...m, b });
    return true;
  };

  /** @returns 这次抬手是不是被框选吃掉了（吃掉了相机和物件都别再收尾） */
  const endMarquee = () => {
    clearTimeout(pressRef.current?.timer);
    pressRef.current = null;
    const m = marqueeRef.current;
    marqueeRef.current = null;
    if (!m) return false;
    setMarquee(null);
    if (Math.abs(m.b.sx - m.a.sx) < MARQUEE_MIN && Math.abs(m.b.sy - m.a.sy) < MARQUEE_MIN) {
      setSelectedIds([]);           // 长按了但没拉开 = 点了一下空地
      return true;
    }
    const x0 = Math.min(m.a.wx, m.b.wx); const x1 = Math.max(m.a.wx, m.b.wx);
    const y0 = Math.min(m.a.wy, m.b.wy); const y1 = Math.max(m.a.wy, m.b.wy);
    // 判据是**相交**不是包含：拉框的人不会去精确包住每一件，框到一半就算
    // （访达、Figma 都是相交）。相交真身在 board-geometry（08-27 收敛）
    const sel = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const hit = (x, y, w, h) => rectsHit({ x, y, w, h }, sel);
    const ids = [];
    for (const o of positionedRef.current) {
      const sz = sizeOf(o);
      if (hit(o.pos.x, o.pos.y, sz.w, sz.h)) ids.push(o.id);
    }
    for (const z of folderViewRef.current) if (hit(z.x, z.y, z.w, z.h)) ids.push(z.id);
    setSelectedIds(ids);
    recentDragMovedRef.current = true;   // 这一下不是点击，别让它把选中清掉
    return true;
  };

  return { marquee, armMarquee, moveMarquee, endMarquee };
}
