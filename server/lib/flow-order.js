/**
 * lib/flow-order.js —— reflow 的名次（2026-09-11 站主定）
 *
 * 以前 reflow 只看位置（先上后下），agent 想说「按这个顺序」只能先把坐标摆对 ——
 * 可坐标正是它算不准的东西（见 board-place.js 头注）。flow 线是它本来就会画的关系，
 * 所以：**线上的件按线排，线外的件留在原来的名次**。
 *
 * 做法：先按位置排出名次；flow 线连着的那些件占着的名次，按线的拓扑序重新填。
 * 分叉 / 汇合时同一层按位置先后；成环的部分退回位置序。标题、批注这类线外的件
 * 名次不动（标题不会被挤到最后）。用户拖过的件照样参与（站主：用户拖过的也能被 agent 重排）。
 *
 * 纯函数，不读盘。
 */

/**
 * @param {Array<{id:string}>} items  已按位置排好的组员
 * @param {Array<{from:string,to:string}>} flows  flow 线（只取两端都在组里的）
 * @returns {{ order: Array, byFlow: boolean, onLine: number }}
 */
export function flowOrder(items, flows) {
  const rank = new Map(items.map((m, i) => [m.id, i]));
  const edges = (flows || []).filter((f) => rank.has(f.from) && rank.has(f.to) && f.from !== f.to);
  if (!edges.length) return { order: items, byFlow: false, onLine: 0 };

  const onLine = new Set(edges.flatMap((f) => [f.from, f.to]));
  const indeg = new Map([...onLine].map((id) => [id, 0]));
  const next = new Map([...onLine].map((id) => [id, []]));
  for (const f of edges) { indeg.set(f.to, indeg.get(f.to) + 1); next.get(f.from).push(f.to); }

  const byRank = (a, b) => rank.get(a) - rank.get(b);
  const ready = [...onLine].filter((id) => indeg.get(id) === 0);
  const topo = [];
  while (ready.length) {
    ready.sort(byRank);
    const id = ready.shift();
    topo.push(id);
    for (const t of next.get(id)) { indeg.set(t, indeg.get(t) - 1); if (indeg.get(t) === 0) ready.push(t); }
  }
  const seen = new Set(topo);
  for (const id of [...onLine].sort(byRank)) if (!seen.has(id)) topo.push(id);   // 环：按位置补

  const byId = new Map(items.map((m) => [m.id, m]));
  let k = 0;
  const order = items.map((m) => (onLine.has(m.id) ? byId.get(topo[k++]) : m));
  return { order, byFlow: true, onLine: onLine.size };
}
