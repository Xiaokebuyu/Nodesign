/**
 * server/lib/rect.js —— 矩形原语（2026-08-27 审计收敛）
 *
 * 收敛前的账：AABB 重叠判定在服务端手写了 4 份、包围盒 5 份、UNIT=24 两处
 * export，各自维护、容差和空集语义悄悄分叉（bbox 空集有的返回 null 有的返回
 * 零框）。改判定只改这一份；需要不同空集语义的调用方自己在出口包一层。
 *
 * 前端的对应物是 web/src/lib/board-geometry.js 的 rectsHit —— 语义必须一致
 * （相邻贴边 = 不重叠）。改这边记得看那边。
 */

/** 网格步长：全部世界坐标的公倍数。曾在 board-place / sketch-layout 各 export 一份。 */
export const UNIT = 24;

/** AABB 重叠（贴边不算重叠）。pad = 双方各让的身位。 */
export const overlaps = (a, b, pad = 0) => !(
  a.x + a.w + pad <= b.x || b.x + b.w <= a.x - pad
  || a.y + a.h + pad <= b.y || b.y + b.h <= a.y - pad
);

/** 一组矩形的包围盒；空集返回 null（要零框语义自己在出口兜）。 */
export function bboxOf(rects) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + (r.w || 0)); y1 = Math.max(y1, r.y + (r.h || 0));
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** 点在矩形内（含边）。 */
export const pointIn = (pt, r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;

/**
 * 线段 a→b 是否穿过矩形 r（Liang-Barsky 裁剪；端点擦边也算穿）。
 * 落位引擎用它判「连线走廊」：新块和它锚点之间那条线会不会压在第三块身上。
 */
export function segHitsRect(a, b, r) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  let t0 = 0; let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;               // 与这条边平行：q<0 = 整段在外
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x)
    && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y);
}
