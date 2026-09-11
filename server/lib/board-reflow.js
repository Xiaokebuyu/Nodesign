/**
 * lib/board-reflow.js —— reflow 的排法（2026-09-11，从 edit-board.js 拆出）
 *
 * 以前 reflow 只会把一组堆成一列或一行，跟画图时那套布局（grid / flow 分层 / mindmap）
 * 是两份东西：用 grid 两列画的组改了字之后，只能被 reflow 压成一列，agent 于是一件件
 * 手挪回两列 —— 09-11 量桌面真会话，挪动里大半是这种「组内排列」的手工活。
 *
 * 现在：reflow 就是**拿这组当初的布局，按现在的线和尺寸再算一遍**。
 *   - 布局名：调用方显式给的 > 这组画图时登记的（board.layouts[tag]）> column
 *   - 名次：有 flow 线就按线（flow-order.js），线外的留在原名次；没有线按位置
 *   - column / row 照旧是紧凑堆叠（set_text 改高后重堆的老用法不变）
 *   - grid / flow / mindmap 走 sketch-layout.js 的 layoutNodes，跟画图同一份引擎
 *   - 结果贴回这组原来的左上角（组不会因为重排跑到别处去）
 *
 * 纯函数：吃成员的矩形和线，吐每件的新坐标，不读盘不落盘。
 */
import { layoutNodes } from './sketch-layout.js';
import { flowOrder } from './flow-order.js';

export const REFLOW_LAYOUTS = Object.freeze(['column', 'row', 'grid', 'flow', 'mindmap']);
const STACK_GAP = 16;

/**
 * @param {Array<{id:string, r:{x,y,w,h}}>} members  组员（不含涂鸦）
 * @param {object} opts
 *   layout    显式要的布局（REFLOW_LAYOUTS 之一）；不给就用 recorded，再不行 column
 *   recorded  这组画图时登记的 {layout, cols?}
 *   cols      显式列数（grid）
 *   bindings  板上全部线（只取两端都在组里的）
 * @returns {{ layout:string, cols:number|null, order:Array, byFlow:boolean, onLine:number, pos:Map<string,{x,y}> }}
 */
export function reflowGroup(members, { layout = null, recorded = null, cols = null, bindings = [] } = {}) {
  const rec = recorded && REFLOW_LAYOUTS.includes(recorded.layout) ? recorded : null;
  const tpl = REFLOW_LAYOUTS.includes(layout) ? layout : (rec?.layout || 'column');
  const nCols = cols ?? (tpl === rec?.layout ? rec?.cols : null) ?? null;
  const horizontal = tpl === 'row';

  const byPos = [...members].sort((a, b) => (horizontal ? a.r.x - b.r.x || a.r.y - b.r.y : a.r.y - b.r.y || a.r.x - b.r.x));
  const ids = new Set(members.map((m) => m.id));
  const inner = bindings.filter((b) => b && ids.has(b.from) && ids.has(b.to) && b.from !== b.to);
  const { order, byFlow, onLine } = flowOrder(byPos, inner.filter((b) => b.type === 'flow'));

  const left = Math.min(...members.map((m) => m.r.x));
  const top = Math.min(...members.map((m) => m.r.y));
  const pos = new Map();
  if (tpl === 'column' || tpl === 'row') {
    let cur = horizontal ? left : top;
    for (const m of order) {
      pos.set(m.id, horizontal ? { x: cur, y: top } : { x: left, y: cur });
      cur += (horizontal ? m.r.w : m.r.h) + STACK_GAP;
    }
  } else {
    const local = layoutNodes(order.map((m) => ({ key: m.id, w: m.r.w, h: m.r.h })),
      { template: tpl, cols: nCols, edges: inner.map((b) => ({ from: b.from, to: b.to })) });
    const ps = [...local.values()];
    const minX = Math.min(...ps.map((p) => p.x)); const minY = Math.min(...ps.map((p) => p.y));
    for (const m of order) { const p = local.get(m.id); pos.set(m.id, { x: Math.round(left + p.x - minX), y: Math.round(top + p.y - minY) }); }
  }
  return { layout: tpl, cols: tpl === 'grid' ? nCols : null, order, byFlow, onLine, pos };
}

/**
 * 改字变高之后，把同组压在它下面的顺着往下推（2026-09-11）。以前要 agent 记得接一个 reflow，
 * 忘了就压字。只推「在它原底边之下、横向有重叠」的同组件，而且只在变高后真会压上时推；
 * 推的量 = 压上的那截 + 间距，被推的几件彼此的间距不变。变矮不往上收（留白可能是用户拖出来的）。
 * @param {{x,y,w,h}} grown  变高后的矩形（h 是新高）
 * @param {number} oldH
 * @param {Array<{id:string, r:{x,y,w,h}}>} others  同组其余件
 * @returns {Array<{id:string, dy:number}>}
 */
export function pushDownAfterGrow(grown, oldH, others) {
  if (!(grown.h > oldH)) return [];
  const below = others.filter(({ r }) => r.y >= grown.y + oldH - 1 && r.x < grown.x + grown.w && grown.x < r.x + r.w);
  if (!below.length) return [];
  const dy = Math.round(grown.y + grown.h + STACK_GAP - Math.min(...below.map(({ r }) => r.y)));
  return dy > 0 ? below.map(({ id }) => ({ id, dy })) : [];
}
