/**
 * server/lib/lineage.js —— 谱系收叠的服务端镜像（2026-09-17）
 *
 * 前端 `web/src/lib/lineage.js` 把改自链的旧版藏到现役版身后（卡上 ⧉N，点开展开）。
 * 在这之前服务端对此一无所知：read_board 照常逐件列出被藏起来的旧版，锚点能落到一张
 * 用户看不见的卡旁边，agent 看到的板和用户看到的板不是同一块。
 *
 * **镜像不是重写**：下面 lineageFolds 的函数体必须与前端逐字相同，lineage.test.js
 * 读两份源码比对（npm 包不带 web/src，不能 import 过来；同 board-hero.js 的做法）。
 *
 * 服务端不知道用户点开了哪一摞（展开态只活在浏览器里），一律按默认的收起算。
 * 收叠只发生在桌面根层（前端入座 computeDesktopSeating 只对根层做），这里同口径。
 */
import { layerOf } from './canvas-id.js';

// ── 以下到 END-MIRROR 与 web/src/lib/lineage.js 逐字一致 ──
export function lineageFolds(ids, bindings, openTips = new Set()) {
  const present = new Set(ids);
  const edges = Object.values(bindings || {}).filter(b =>
    b.type === 'derives-from' && present.has(b.from) && present.has(b.to));
  const hidden = new Set();
  const stacks = new Map();
  if (!edges.length) return { hidden, stacks };

  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const touched = new Set();
  for (const e of edges) {
    for (const end of [e.from, e.to]) if (!parent.has(end)) { parent.set(end, end); touched.add(end); }
    const ra = find(e.from); const rb = find(e.to);
    if (ra !== rb) parent.set(ra, rb);
  }
  const olds = new Set(edges.map(e => e.to));
  const groups = new Map();
  for (const id of touched) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  for (const members of groups.values()) {
    const tips = members.filter(m => !olds.has(m));
    if (tips.length !== 1) continue;          // 环 / 分叉：不折叠
    const tip = tips[0];
    const rest = members.filter(m => m !== tip);
    if (!rest.length) continue;
    const open = openTips.has(tip);
    stacks.set(tip, { count: rest.length, open });
    if (!open) for (const m of rest) hidden.add(m);
  }
  return { hidden, stacks };
}
// ── END-MIRROR ──

/**
 * 这块板根层此刻叠着的谱系。
 *
 * @returns {{ hidden: Set<string>, tipOf: Map<string,string>, olds: Map<string,string[]> }}
 *   hidden  被叠在身后、用户看不见的旧版
 *   tipOf   旧版 → 它叠在哪张现役版身后
 *   olds    现役版 → 身后的旧版（新的在前）
 */
export function boardLineage(board) {
  const known = new Set(Object.keys(board?.zones || {}));
  const ids = [];
  for (const [id, e] of Object.entries(board?.objects || {})) {
    if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y)) continue;
    if (layerOf(id, e, known) !== '') continue;
    ids.push(id);
  }
  const bindings = board?.bindings || {};
  const { hidden, stacks } = lineageFolds(ids, bindings);
  const tipOf = new Map();
  const olds = new Map();
  if (!hidden.size) return { hidden, tipOf, olds };
  // 成员归属：从链尾出发沿改自边（不分方向）走遍它那一组。组内可能有旧版之间的环，
  // 顺着「新→旧」单向走会漏掉，所以按连通走；先走到的离现役版近，顺序即「新的在前」。
  const inStack = (id) => hidden.has(id) || stacks.has(id);
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const b of Object.values(bindings)) {
    if (b?.type !== 'derives-from' || !inStack(b.from) || !inStack(b.to)) continue;
    link(b.from, b.to); link(b.to, b.from);
  }
  for (const tip of stacks.keys()) {
    const order = [];
    const seen = new Set([tip]);
    let frontier = [tip];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        for (const o of adj.get(id) || []) {
          if (seen.has(o) || !hidden.has(o)) continue;
          seen.add(o); order.push(o); tipOf.set(o, tip); next.push(o);
        }
      }
      frontier = next;
    }
    olds.set(tip, order);
  }
  return { hidden, tipOf, olds };
}
