/**
 * canvas-id —— agent 侧画布 id 归一化（2026-08-14，摆位批）
 *
 * id = kind 前缀 + 工作区相对路径（board 的铁律）。agent 传进来的写法五花八门
 * （反斜杠 / ./ 前缀 / 裸 .html），read_board / arrange_on_board / create_on_board
 * 共用这一份归一。跟 pin_to_board 内联的那段同源同规则 —— 收敛计划里它也该
 * 迁过来（现在没动它：改稳定工具要单独一刀）。
 */

export function normalizeCanvasId(raw) {
  let id = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  if (!id || id.includes('..')) return null;
  // （doc:brand / doc:_root 映射 2026-08-24 拆除：项目文档并进根 CLAUDE.md，
  //   记忆住 记忆/，都是普通画布文件，没有特殊 id 了）
  if (!/^(deck|site|doc|text|scribble):/.test(id) && /\.html?$/i.test(id)) return `deck:${id}`;
  return id;
}

/**
 * 一个 tag 下所有座位的包络（08-23 案：near 只认节点 id 不认 tag，可 tag 本来
 * 就是"一片东西的名字"——刚用 tag 画完草图，把 tag 传给 near 是自然写法）。
 * 返回 { x, y, w, h, anchorId, ids } 或 null；anchorId = 最右那个（贴右侧摆用）。
 * sizeOf(id, entry) 由调用方给（estimateSizeOn 绑着 board，不在这层 import）。
 */
/**
 * 查 tag 时的归一：剥掉前导 `#`（2026-08-30）。
 *
 * ⛔ 我们在 write_on_board 的 `near`、read_board 的 `tag` 等好几处描述里明写
 * 「Canvas id or **#tag**」，而查询侧一直是 `e.tag === raw` 精确比对，从来没剥过
 * 这个井号 —— 全库统计：带 # 的写法 5 处，5 处全废；不带 # 的 2773 处全通。
 * 「注释/描述声称做了、代码没做」的第三例。
 *
 * 只用在**查**的一侧。写的一侧（write_on_board 的 tag 参数）走 TAG_RE，本来就
 * 收不下 # —— 那是 schema 报错，是响的，不用管。
 */
export function bareTag(raw) {
  return String(raw ?? '').trim().replace(/^#+/, '');
}

export function tagEnvelope(board, rawTag, sizeOf) {
  const tag = bareTag(rawTag);
  if (!tag) return null;
  const hits = Object.entries(board?.objects || {})
    .filter(([, e]) => e?.tag === tag && Number.isFinite(e?.x));
  if (!hits.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  let anchorId = null; let rightEdge = -Infinity;
  for (const [id, e] of hits) {
    const s = sizeOf(id, e) || { w: 0, h: 0 };
    x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y);
    x2 = Math.max(x2, e.x + s.w); y2 = Math.max(y2, e.y + s.h);
    if (e.x + s.w > rightEdge) { rightEdge = e.x + s.w; anchorId = id; }
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, anchorId, ids: hits.map(([id]) => id) };
}

/**
 * 它住在哪一层（服务端近似版）：显式 zone 字段优先，其次沿路径往上找第一个
 * 已知文件夹。已知集 = board.zones 的 key —— 比前端少了"服务端扫出来的任务
 * 目录"这一路，没摆过的深层目录会归到根。read_board 的输出里写明这是近似。
 */
export function layerOf(id, entry, knownFolders) {
  // 显式 zone 只认**真实存在的层**（'' 或 zones 里有的文件夹）。历史上
  // pin_to_board 往 zone 里写过 'assets/generated' 这类前端根本不当层渲染的
  // 路径（iss_mt5t487g：pin 上来的图被判在"assets 层"，arrange 跟根层的草图
  // 节点一比就拒）——错标签直接落回按路径推，存量脏数据顺带自愈。
  if (entry && typeof entry.zone === 'string'
    && (entry.zone === '' || knownFolders?.has?.(entry.zone))) return entry.zone;
  const s = String(id);
  const c = s.indexOf(':');
  const p = (c > 0 && /^[a-z]+$/.test(s.slice(0, c))) ? s.slice(c + 1) : s;
  let d = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  while (d && !knownFolders.has(d)) {
    const i = d.lastIndexOf('/');
    d = i > 0 ? d.slice(0, i) : '';
  }
  return d;
}
