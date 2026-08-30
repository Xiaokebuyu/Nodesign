/**
 * server/lib/board-transform.js —— 整组缩放/旋转（2026-08-30 画图能力线）
 *
 * 画完一幅想整体缩小/转个角度，此前只能逐笔挪。以组（tag）为单位绕组心变换：
 *   - 涂鸦（scribble）**真变形**：d 逐点过矩阵、包围盒重建 —— 线条真的转过去
 *   - 其他成员（text/板书/产物卡）**只换座不变形**：字号和卡面没有"转 30°"的
 *     渲染语义，硬转是把问题藏起来 —— 中心点跟着矩阵走、如实报"这几件只挪了位"
 *
 * 纯函数：算出 objects patch 交回，落盘归调用方（edit-board）。
 */

import { transformD } from './sketch-layout.js';

/**
 * @param members  [{id, entry, w, h}]（w/h 是估好的真尺寸）
 * @param opts     { scale?: 0.3..3, rotate?: 度, about?: {x,y} 世界像素（缺省组心）}
 * @returns {{ patch: Record<string, object>, inked: number, seated: number, center: {x,y} }}
 */
export function transformGroup(members, { scale = 1, rotate = 0, about = null } = {}) {
  const minX = Math.min(...members.map((m) => m.entry.x));
  const minY = Math.min(...members.map((m) => m.entry.y));
  const maxX = Math.max(...members.map((m) => m.entry.x + m.w));
  const maxY = Math.max(...members.map((m) => m.entry.y + m.h));
  const C = about || { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const th = (rotate * Math.PI) / 180;
  const cos = Math.cos(th); const sin = Math.sin(th);
  const T = (p) => ({
    x: C.x + ((p.x - C.x) * cos - (p.y - C.y) * sin) * scale,
    y: C.y + ((p.x - C.x) * sin + (p.y - C.y) * cos) * scale,
  });

  const patch = {};
  let inked = 0; let seated = 0;
  for (const m of members) {
    const e = m.entry;
    if (m.id.startsWith('scribble:') && typeof e?.data?.d === 'string') {
      let mnX = Infinity; let mnY = Infinity; let mxX = -Infinity; let mxY = -Infinity;
      const dAbs = transformD(e.data.d, (p) => {
        const q = T({ x: e.x + p.x, y: e.y + p.y });
        if (q.x < mnX) mnX = q.x; if (q.x > mxX) mxX = q.x;
        if (q.y < mnY) mnY = q.y; if (q.y > mxY) mxY = q.y;
        return q;
      });
      if (!Number.isFinite(mnX)) { seated += 1; continue; }
      const P = 6;
      const d = transformD(dAbs, (p) => ({ x: p.x - mnX + P, y: p.y - mnY + P }));
      patch[m.id] = {
        ...e, x: Math.round(mnX - P), y: Math.round(mnY - P),
        w: Math.max(4, Math.round(mxX - mnX + P * 2)), h: Math.max(4, Math.round(mxY - mnY + P * 2)),
        data: { ...e.data, d },
      };
      inked += 1;
    } else {
      // 只换座：中心过矩阵，尺寸不动
      const c0 = { x: e.x + m.w / 2, y: e.y + m.h / 2 };
      const c1 = T(c0);
      patch[m.id] = { ...e, x: Math.round(c1.x - m.w / 2), y: Math.round(c1.y - m.h / 2) };
      seated += 1;
    }
  }
  return { patch, inked, seated, center: { x: Math.round(C.x), y: Math.round(C.y) } };
}
