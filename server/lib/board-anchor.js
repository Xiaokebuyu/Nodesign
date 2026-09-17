/**
 * server/lib/board-anchor.js —— 锚点解析（2026-08-27 行数棘轮拆件；09-11 收成全工具共用一份）
 *
 * 从 mcp/tools/write-on-board.js **原样**搬出：真 id > tag 包络 > **救援入座**
 * （文件真在只是还没座位 —— 当场给它排一个再锚。入座下沉后防抖 1.5s 内的窗口、
 * 以及历史欠座都从这里兜住，「还没有座位」这个失败类只剩"确实不存在"一种真情况）。
 *
 * 09-11 加两层（意图层落位之后写板硬失败的大头成了「锚点不在板上」，全是自然叫法：
 * 「角色档案站（site）」「etsuko-site/index.html」「品牌手册」「browse@48,10」）：
 *   宽认 —— 剥括注 / 坐标尾巴、补 site:/docx: 前缀、xx/index.html 认站点、目录名认那片、
 *           唯一同名、唯一包含。**只收唯一命中**，命中了带 fuzzy 让调用方如实报「认成了谁」。
 *           锚认错的代价只是摆位偏一点；「挪谁 / 删谁 / 线连谁」这类目标不走宽认。
 *   候选 —— 认不出时 anchorMissHint 给最像的两三个 id，而不是只说「read_board 看一眼」。
 *
 * readBoard / seatArtifacts 走注入，不在这里 import —— lib 不该反向抓 engine/runs
 * 和 projects 层的东西；纯几何依赖（canvas-id / board-kind-sizes）留作直接 import。
 *
 * 09-17 三处（问题库 iss_mt9cmke6_pset / iss_mtp465ds_ctko / iss_mtgcjmnf_tye4）：
 *   - 救援入座后按入座器**实际落座的 id** 回查（seatArtifacts 返回 ids），不再猜 `deck:<路径>` / 裸路径；
 *   - 同名目录是一张目录型产物卡（站点 / word 文件夹 / 演出）时认卡，不认那层文件夹坐标；
 *   - 认不出时说清磁盘上查没查过（anchorMissWhy），「磁盘上也没有」只在真查过时才说。
 *   写法变体（nameVariants）导出给线的端点归一共用（lib/board-endpoint.js）。
 */

import { layerOf, normalizeCanvasId, tagEnvelope } from './canvas-id.js';
import { estimateSizeOn, FOLDER_CARD } from './board-kind-sizes.js';
import { KINDS } from './kinds/index.js';

const PREFIX_RE = /^(deck|site|docx|doc|stage|text|scribble):/;
/** 目录型卡的前缀（注册表里声明了 directory 的形态）：这种卡的地址就是一个目录 */
const DIR_CARD_PREFIXES = Object.entries(KINDS).filter(([, def]) => def.directory).map(([id]) => `${id}:`);
/** 文字里嵌着的画布 id（摘要里印的 `手写字「…」（text:t1）` 被整段抄回来时认它） */
const EMBEDDED_ID_RE = /(?:deck|site|docx|stage|text|scribble):[^\s（）()「」“”"'`，,、；;]+/g;
const bareOf = (id) => String(id).replace(PREFIX_RE, '');
const stem = (s) => bareOf(s).split('/').pop().replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase();

/** 自然叫法的外壳：#、引号、「（site）」这类括注、「@48,10」这类坐标尾巴 */
export function cleanAnchorName(raw) {
  return String(raw ?? '').trim()
    .replace(/^[#「“"'`]+|[」”"'`]+$/g, '')
    .replace(/\s*[（(][^（()）]{0,20}[)）]\s*$/, '')
    .replace(/@-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, '')
    .trim();
}

/** 板上能当锚的名字：文件夹、有座位的物件（画布文字节点只收带局部 id 的）、tag */
function anchorables(b) {
  const out = [];
  for (const z of Object.keys(b?.zones || {})) out.push({ id: z, label: z });
  const tags = new Set();
  for (const [id, e] of Object.entries(b?.objects || {})) {
    if (!Number.isFinite(e?.x) || id.startsWith('scribble:')) continue;
    if (e.tag) tags.add(e.tag);
    if (id.startsWith('text:')) { if (e.data?.lid) out.push({ id, label: e.data.lid }); continue; }
    out.push({ id, label: bareOf(id) });
  }
  for (const t of tags) out.push({ id: `#${t}`, label: t });
  return out;
}

const bigrams = (t) => { const g = new Set(); for (let i = 0; i < t.length - 1; i += 1) g.add(t.slice(i, i + 2)); if (t.length === 1) g.add(t); return g; };
function similarity(a, b) {
  const x = stem(a); const y = stem(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.8;
  const A = bigrams(x); const B = bigrams(y); let n = 0;
  for (const g of A) if (B.has(g)) n += 1;
  return (2 * n) / ((A.size + B.size) || 1);
}

/** 认不出时的「最像的」：分数够的前 n 个 id */
export function suggestAnchors(raw, b, n = 3) {
  const c = cleanAnchorName(raw);
  return anchorables(b)
    .map((a) => ({ id: a.id, s: Math.max(similarity(c, a.label), similarity(c, a.id)) }))
    .filter((a) => a.s >= 0.34).sort((p, q) => q.s - p.s).slice(0, n).map((a) => a.id);
}

/** 锚点认不出时报错的后半句：有像的就点名，没有就指 read_board */
export function anchorMissHint(raw, b) {
  const s = suggestAnchors(raw, b);
  return s.length ? `最像的：${s.join(' / ')}（照抄 id 再试）` : 'read_board 看一眼现在都有谁';
}

/** 板上跟这个目录同名的目录型产物卡（有座位的）；没有返回 null */
export function dirCardOn(b, dir) {
  const d = String(dir || '').replace(/\/+$/, '');
  if (!d) return null;
  return DIR_CARD_PREFIXES.map((p) => `${p}${d}`).find((id) => Number.isFinite(b?.objects?.[id]?.x)) || null;
}

/**
 * 近乎精确的写法变体（不猜）：括注里写着的 id、剥壳后的原名、xx/index.html → 站点、补前缀。
 * 锚点解析与线的端点归一共用这一份（09-17：端点原来一条都不认）。
 * @returns {Array<[string, string]>} [候选写法, 怎么认的]
 */
export function nameVariants(raw) {
  const t = String(raw ?? '').trim();
  const c = cleanAnchorName(raw);
  if (!c) return [];
  const out = [];
  const embedded = [...new Set(t.match(EMBEDDED_ID_RE) || [])];
  if (embedded.length === 1 && embedded[0] !== t) out.push([embedded[0], '照括注里写着的 id']);
  if (c !== t) out.push([c, '去掉括注 / 坐标尾巴']);
  const dir = c.replace(/\/index\.html?$/i, '');
  if (dir !== c) out.push([`site:${dir}`, '站点入口认成站点'], [dir, '站点入口认成它的目录']);
  out.push([`site:${c}`, '补 site: 前缀'], [`docx:${c}`, '补 docx: 前缀']);
  return out;
}

const MISS_WHY = {
  missing: '既没有座位、不是任何 tag，磁盘上也没有这个文件',
  skipped: '既没有座位、不是任何 tag；磁盘上这个路径不作为一张卡上画布（文件夹、隐藏目录、exports/、assets/ 深处等）',
  unseated: '既没有座位、不是任何 tag，这次也没能给它入座',
};
/**
 * 认不出时的前半句（09-17）：「磁盘上也没有」只在入座器真去磁盘查过、文件确实不在时才说 ——
 * 此前三个写板入口一律这么报，救援入座按错 id 回查失败时这句话是假的。
 * @param {Function} resolver  makeAnchorResolver 的返回值
 */
export function anchorMissWhy(resolver, raw) {
  return MISS_WHY[resolver?.missOf?.(raw)] || '既没有座位，也不是任何 tag';
}

/**
 * @param {object} deps
 *   projectId       救援入座要按项目发
 *   known           Set(board.zones 的键) —— layerOf 的分层判据
 *   readBoard       (pid) => board       救援后重读
 *   seatArtifacts   (pid, [rel]) => {seated}
 * @returns {(raw: string, b: object) => Promise<{anchorId,zone,rect,board,rescued?,folder?,fuzzy?:{from,how}}|null>}
 */
export function makeAnchorResolver({ projectId, known, readBoard, seatArtifacts }) {
  const sizeOf = (b) => (id, e) => estimateSizeOn(b, id, e);
  const misses = new Map();   // raw → 救援入座的结局（missing / skipped / unseated），给 anchorMissWhy 用

  async function exact(raw, b, { rescue = true } = {}) {
    // 文件夹卡也是锚（2026-09-05 意图层：place.by:"素材" 是很自然的写法）
    const zname = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
    const z = zname && b.zones?.[zname];
    if (z && Number.isFinite(z.x) && Number.isFinite(z.y)) {
      // 同名目录其实是一张站点 / word 文件夹卡（09-17 iss_mtp465ds_ctko）：那层坐标前端不画，认卡
      const card = dirCardOn(b, zname);
      if (card) return { ...(await exact(card, b, { rescue: false })), fuzzy: { from: raw, how: '同名目录是一张产物卡，不是文件夹' } };
      return { anchorId: zname, zone: '', rect: { x: z.x, y: z.y, ...FOLDER_CARD }, board: b, folder: true };
    }
    const nid = normalizeCanvasId(raw);
    const e = nid ? b.objects?.[nid] : null;
    if (e && Number.isFinite(e.x)) {
      return { anchorId: nid, zone: layerOf(nid, e, known), rect: { x: e.x, y: e.y, ...estimateSizeOn(b, nid, e) }, board: b };
    }
    const env = tagEnvelope(b, raw, sizeOf(b));
    if (env) {
      return { anchorId: env.anchorId, zone: layerOf(env.anchorId, b.objects[env.anchorId], known), rect: { x: env.x, y: env.y, w: env.w, h: env.h }, board: b };
    }
    if (rescue && nid) {
      const bare = bareOf(nid);
      const r = await seatArtifacts(projectId, [bare]).catch(() => null);
      const key = String(raw);
      if (r?.missing?.includes(bare)) misses.set(key, 'missing');
      else if (r?.skipped?.includes(bare)) misses.set(key, 'skipped');
      else if (r?.ids) misses.set(key, 'unseated');
      // 回查按入座器**实际落座的 id**（09-17）：它按注册表把 `十三机兵/index.html` 落成 `site:十三机兵`，
      // 按 `deck:十三机兵/index.html` / 裸路径查是查不到的。ids 缺席（老调用形状）才退回猜。
      if (r?.ids?.[bare] || r?.seated) {
        const nb = await readBoard(projectId);
        const realId = r.ids?.[bare] || (nb.objects?.[nid] ? nid : bare);
        const ne = nb.objects?.[realId];
        if (ne && Number.isFinite(ne.x)) {
          misses.delete(key);
          return {
            anchorId: realId, zone: layerOf(realId, ne, known), rect: { x: ne.x, y: ne.y, ...estimateSizeOn(nb, realId, ne) }, board: nb,
            rescued: !b.objects?.[realId],
            ...(realId !== nid && realId !== bare ? { fuzzy: { from: raw, how: '这个文件归这张卡（按产物注册表认）' } } : {}),
          };
        }
      }
    }
    return null;
  }

  /**
   * 顺序有讲究：精确（不入座）→ 近乎精确的写法变体（不入座）→ 原名救援入座 → 宽认。
   * 变体排在入座前：`xx/index.html` 真在盘上时，别再给它排一张跟站点卡重复的新卡。
   * 入座排在宽认前：盘上真有 `logo-v2.png` 只是没座位时，别被「唯一包含」认成板上的 `logo.png`。
   */
  async function resolveAnchor(raw, b) {
    misses.delete(String(raw));
    const hit = await exact(raw, b, { rescue: false });
    if (hit) return hit;
    const c = cleanAnchorName(raw);
    if (!c) return null;
    const tag = (r, how) => (r ? { ...r, fuzzy: { from: raw, how: r.fuzzy ? `${how}；${r.fuzzy.how}` : how } } : null);

    // 写法变体：括注里的 id、剥壳后的原名、xx/index.html → 站点、补前缀
    for (const [v, how] of nameVariants(raw)) {
      const r = await exact(v, b, { rescue: false });
      if (r) return tag(r, how);
    }
    const rescued = await exact(raw, b);
    if (rescued) return rescued;

    // 目录名：这个目录下已上板的东西整片当锚（最右那件当代表，跟 tag 包络同一条规则）
    const under = Object.entries(b.objects || {}).filter(([id, e]) => Number.isFinite(e?.x) && bareOf(id).startsWith(`${c.replace(/\/+$/, '')}/`));
    if (under.length) {
      let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity; let anchorId = null; let right = -Infinity;
      for (const [id, e] of under) {
        const s = estimateSizeOn(b, id, e);
        x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y); x2 = Math.max(x2, e.x + s.w); y2 = Math.max(y2, e.y + s.h);
        if (e.x + s.w > right) { right = e.x + s.w; anchorId = id; }
      }
      return tag({ anchorId, zone: layerOf(anchorId, b.objects[anchorId], known), rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, board: b }, `目录「${c}」下已上板的 ${under.length} 件`);
    }

    // 唯一同名，其次唯一包含（两个以上就不猜，交给候选）
    const pool = anchorables(b);
    const k = stem(c);
    const same = pool.filter((a) => stem(a.label) === k);
    const contains = k.length >= 2 ? pool.filter((a) => { const s = stem(a.label); return s.length >= 2 && (s.includes(k) || k.includes(s)); }) : [];
    const pick = same.length === 1 ? [same[0], '同名'] : (!same.length && contains.length === 1 ? [contains[0], '名字包含'] : null);
    if (pick) return tag(await exact(pick[0].id, b, { rescue: false }), pick[1]);
    return null;
  }
  resolveAnchor.missOf = (raw) => misses.get(String(raw)) || null;
  return resolveAnchor;
}
