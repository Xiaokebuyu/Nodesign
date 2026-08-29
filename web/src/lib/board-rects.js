/**
 * 画布上「谁占了哪块地」的唯一一份算法（2026-08-28）
 *
 * 这份表在 BoardCanvas 里原来写了三遍：幻影找座的障碍表、小地图的条目、
 * 以及 08-28 新加的阅读序。三处都是同一句话 ——「物件的 pos 加上 sizeOf 的
 * 宽高」—— 但各写各的，形状还差着一点（有的带 id，有的不带）。
 *
 * 一件事各执一词就是债：哪天 sizeOf 多一个分支（比如某种形态要算上标题栏），
 * 改一处漏两处，表现是"小地图上它是这么大，精灵避让时它是那么大"，而且不报错。
 *
 * ⚠️ 一律带 id 出去。多一个字段对障碍表无害（碰撞只读 x/y/w/h），少一个字段
 * 对小地图和阅读序是致命的 —— 宁可统一带上，也别让调用方各自补。
 */
import { sizeOf } from './board-kinds.js';

/** 物件（positioned 那份：带 pos{x,y} 和形态）→ 矩形 */
export function objectRects(objects) {
  return (objects || []).map((o) => {
    const sz = sizeOf(o);
    return { id: o.id, x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h };
  });
}

/** 文件夹 / 工作区（folderView 那份：本来就是矩形）→ 同一个形状 */
export function zoneRects(zones) {
  return (zones || []).map((z) => ({ id: z.id, x: z.x, y: z.y, w: z.w, h: z.h }));
}
