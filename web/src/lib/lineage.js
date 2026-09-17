/**
 * web/src/lib/lineage.js — 谱系收叠（2026-08-14，北极星路线 3）
 *
 * 旧版本是版面上的杂物。真正好看的处理不是把 v1 v2 v3 排成一列，而是旧版
 * **叠在现役版身后**（像一沓纸露出边角），点徽标展开。版面上只剩主角，
 * 历史一摸就有 —— 这比谱系纵列更接近登录墙的克制感（商讨时定的方案）。
 *
 * 规则（保守优先，跟 pickHero 同一气质）：
 *   - 只看 derives-from 边，且两端都在这一层的物件里。
 *   - 按边连通分组；组内「链尾」= 从未出现在 to 侧的成员（from=新 to=旧）。
 *   - **恰好一个链尾才折叠**：零个 = 环、两个以上 = 分叉，都原样铺开 ——
 *     收叠必须无歧义，猜错藏谁比不藏更糟。
 *   - 展开集（用户点开的链尾）里的组不折叠，但链尾仍带徽标（能再收回去）。
 */

/**
 * @param {string[]} ids          这一层的物件 id
 * @param {object} bindings       { [bid]: { type, from, to } }
 * @param {Set<string>} openTips  用户展开的链尾集合
 * @returns {{ hidden: Set<string>, stacks: Map<string, {count:number, open:boolean}> }}
 */
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

/**
 * 每一摞里有哪些旧版（2026-09-17）：从链尾出发沿改自边（不分方向）走遍它那一组，
 * 先走到的离现役版近，顺序即「新的在前」。组内旧版之间可能有环，单向走会漏，所以按连通走。
 * hidden / stacks 取**全部收起**时 lineageFolds 的结果（点开的摞也要知道成员）。
 * @returns {Map<string, string[]>} 链尾 → 旧版
 */
export function lineageMembers(bindings, hidden, stacks) {
  const inStack = (id) => hidden.has(id) || stacks.has(id);
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const b of Object.values(bindings || {})) {
    if (b?.type !== 'derives-from' || !inStack(b.from) || !inStack(b.to)) continue;
    link(b.from, b.to); link(b.to, b.from);
  }
  const olds = new Map();
  for (const tip of stacks.keys()) {
    const order = [];
    const seen = new Set([tip]);
    let frontier = [tip];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        for (const o of adj.get(id) || []) {
          if (seen.has(o) || !hidden.has(o)) continue;
          seen.add(o); order.push(o); next.push(o);
        }
      }
      frontier = next;
    }
    olds.set(tip, order);
  }
  return olds;
}
// ── END-MIRROR（server/lib/lineage.js 逐字镜像到这里为止）──
