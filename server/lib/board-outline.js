/**
 * server/lib/board-outline.js —— 一层板面的大纲（2026-09-17，板书树刀一）
 *
 * ## 为什么
 *
 * read_board 原来给的是一张座次表：先按组列、再按行列散件。它回答的是「谁在哪」，
 * 回答不了「这块板在说什么、说到哪」。真会话里它占了全部板面返回字符的 59%，而且
 * 随时间变长 —— 会话越久，agent 每次读板越贵。
 *
 * 大纲换一个问法：**谁挂在谁下面**。板面本来就是一棵树（回应挂在被回应的下面、
 * 注挂在它说的那件东西上、同一条线的后一节挂在前一节下面），只是从来没有按树印出来。
 *
 * ## 父子怎么推（顺序有讲究，先精确后宽松）
 *
 * 1. `reply_to`：这条板书回应谁 —— 最硬的父子关系，用户点哪条回哪条。
 * 2. `anchor` / annotates 线：这条注说的是哪件东西 —— 注挂在它说的东西下面。
 * 3. 同 tag 的组长：同一个 tag 里按阅读序排第一的那件。⚠️ 不是「前一件」——
 *    那会把一张 40 节点的草图串成 40 层缩进；同 tag 是「一组」，不是一条链。
 * 4. 都没有 = 根。
 *
 * 推不出父的、以及父不在这一层的，都当根。环（互相认爹）按根处理：宁可平铺，
 * 也不能因为数据脏了让整份大纲塌掉。
 */

/** 顺着父链往上走的步数上限：够深了还没到根，就是脏数据（环 / 自认爹），当根处理 */
const MAX_DEPTH = 32;

const readingOrder = (a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x)
  || String(a.id).localeCompare(String(b.id));

/**
 * @param {Array<{id:string, entry:object}>} items  这一层有座位的东西
 * @param {object} [opts]
 * @param {Map<string, {anchor?:string, replyTo?:string}>} [opts.excerpts]  板书的 frontmatter
 * @param {object} [opts.bindings]  board.bindings（认 annotates 线）
 * @returns {Map<string, string|null>} id → 父 id（没有父就是 null）
 */
export function inferParents(items, { excerpts = new Map(), bindings = {} } = {}) {
  const present = new Set(items.map((it) => String(it.id)));
  const annotates = new Map();
  for (const b of Object.values(bindings || {})) {
    if (b?.type !== 'annotates' || !present.has(b.from) || !present.has(b.to)) continue;
    if (!annotates.has(b.from)) annotates.set(b.from, b.to);   // 一条注只认第一个目标
  }
  // 同 tag 的组长：按阅读序排第一的那件，其余都挂在它下面（一层，不串链）
  const headOfTag = new Map();
  const groupHead = new Map();
  for (const it of [...items].sort(readingOrder)) {
    const tag = it.entry?.tag;
    if (!tag) continue;
    if (!headOfTag.has(tag)) { headOfTag.set(tag, String(it.id)); continue; }
    groupHead.set(String(it.id), headOfTag.get(tag));
  }

  const parent = new Map();
  for (const it of items) {
    const id = String(it.id);
    const ex = excerpts.get(id) || {};
    const cand = [ex.replyTo, ex.anchor, annotates.get(id), groupHead.get(id)]
      .map((c) => (typeof c === 'string' ? c : null))
      .find((c) => c && c !== id && present.has(c)) || null;
    parent.set(id, cand);
  }
  // 环与超深：那一支整条当根，别让大纲塌掉
  for (const id of parent.keys()) {
    const seen = new Set([id]);
    let cur = parent.get(id); let n = 0;
    while (cur) {
      if (seen.has(cur) || (n += 1) > MAX_DEPTH) { parent.set(id, null); break; }
      seen.add(cur); cur = parent.get(cur);
    }
  }
  return parent;
}

/**
 * 这一层的大纲：按父子关系排成先根后子、同辈按阅读序（先上后下、先左后右）。
 *
 * @returns {Array<{id:string, entry:object, depth:number, children:number}>}
 *   children = 它底下挂了几件（含孙），用来给「折起的枝」写一行
 */
export function outlineOf(items, opts = {}) {
  const parent = opts.parents || inferParents(items, opts);
  const byId = new Map(items.map((it) => [String(it.id), it]));
  const kids = new Map();
  const roots = [];
  for (const it of [...items].sort(readingOrder)) {
    const id = String(it.id);
    const p = parent.get(id);
    if (p && byId.has(p)) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(id);
    } else roots.push(id);
  }
  const countOf = (id, seen = new Set()) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return (kids.get(id) || []).reduce((n, k) => n + 1 + countOf(k, seen), 0);
  };
  const out = [];
  const walk = (id, depth, seen) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, entry: byId.get(id).entry, depth, children: countOf(id) });
    for (const k of kids.get(id) || []) walk(k, depth + 1, seen);
  };
  const seen = new Set();
  for (const r of roots) walk(r, 0, seen);
  // 兜底：父在表里但因为环没被走到的，平铺补在后面（宁可多列，不可丢件）
  for (const it of [...items].sort(readingOrder)) if (!seen.has(String(it.id))) walk(String(it.id), 0, seen);
  return out;
}
