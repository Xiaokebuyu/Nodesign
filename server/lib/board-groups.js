/**
 * server/lib/board-groups.js —— 画布的「组」与「小地图」（2026-08-23 黑板）
 *
 * 黑板不设几何容器（用户拍板：frame 给黑板开小灶，终局产物卡也要走同一套）。
 * 「组」是派生的：**被线连在一起的一群东西算一组**（连通分量），再加上显式
 * `tag` 字段把没连线的也归到一起。read_board 按组分段输出、用户按组整选、渲染
 * 按组画包络，三处读同一个判据 —— 入座算法里「关系组独占成行」用的也是连通
 * 分量，没有第二份真相。
 *
 * 小地图：把一层的物件投到一张 ≤ 48×16 的字符网格上。模型读网格的整体感远比
 * 读三十行坐标强；从 board.json 直接算，零成本。
 */

/**
 * 连通分量 + tag 合并。
 * @param {string[]} ids           这一层的物件 id
 * @param {object}  bindings       board.bindings
 * @param {(id:string)=>string|null} tagOf
 * @returns {Array<{ members: string[], tags: Set<string>, edges: string[] }>}  大组在前
 */
export function groupObjects(ids, bindings, tagOf = () => null) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const edgesIn = [];
  const cross = [];
  for (const [bid, b] of Object.entries(bindings || {})) {
    if (b.by === 'auto' && b.type === 'ref') continue;   // 自动取材边不成组（蜘蛛网）
    if (!parent.has(b.from) || !parent.has(b.to)) continue;
    // tag 优先：两端 tag 不同（或一端有一端没有）的线是"组间线"，不把两张图粘成一组
    // （08-23 真踩：两张草图之间一条 ref 线让 read_board 把它们报成一组 6 列）
    const ta = tagOf(b.from); const tb = tagOf(b.to);
    if (ta !== tb) { cross.push([bid, b]); continue; }
    union(b.from, b.to); edgesIn.push([bid, b]);
  }
  // 同 tag 归一组
  const byTag = new Map();
  for (const id of ids) {
    const t = tagOf(id);
    if (!t) continue;
    if (!byTag.has(t)) byTag.set(t, id); else union(byTag.get(t), id);
  }
  const groups = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, { members: [], tags: new Set(), edges: [] });
    const g = groups.get(r);
    g.members.push(id);
    const t = tagOf(id); if (t) g.tags.add(t);
  }
  for (const [bid, b] of edgesIn) {
    const g = groups.get(find(b.from));
    if (g) g.edges.push(bid);
  }
  const out = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
  out.cross = cross.map(([bid]) => bid);   // 组间线 id（调用方愿意列就列）
  return out;
}

const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * ASCII 小地图。
 * @param {Array<{id:string,x:number,y:number,w:number,h:number}>} rects
 * @param {{ cols?: number, rows?: number, viewport?: {x,y,w,h}|null }} opts
 * @returns {{ grid: string, legend: Array<[string,string]>, bbox: {x,y,w,h} }|null}
 */
export function asciiMinimap(rects, { cols = 48, rows = 16, viewport = null } = {}) {
  if (!rects.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  if (viewport) {
    x0 = Math.min(x0, viewport.x); y0 = Math.min(y0, viewport.y);
    x1 = Math.max(x1, viewport.x + viewport.w); y1 = Math.max(y1, viewport.y + viewport.h);
  }
  const W = Math.max(1, x1 - x0); const H = Math.max(1, y1 - y0);
  // 等比：一个字符格近似正方（字符高宽比约 2:1，所以横向给两倍格数）
  const scale = Math.max(W / cols, H / (rows * 2));
  const gw = Math.max(1, Math.ceil(W / scale));
  const gh = Math.max(1, Math.ceil(H / (scale * 2)));
  const grid = Array.from({ length: gh }, () => Array(gw).fill('·'));
  const legend = [];
  if (viewport) {
    // 视口边框用 +─│ 画在底下，物件盖在上面
    const cx0 = Math.floor((viewport.x - x0) / scale); const cx1 = Math.min(gw - 1, Math.floor((viewport.x + viewport.w - x0) / scale));
    const cy0 = Math.floor((viewport.y - y0) / (scale * 2)); const cy1 = Math.min(gh - 1, Math.floor((viewport.y + viewport.h - y0) / (scale * 2)));
    for (let x = cx0; x <= cx1; x += 1) { if (grid[cy0]) grid[cy0][x] = '─'; if (grid[cy1]) grid[cy1][x] = '─'; }
    for (let y = cy0; y <= cy1; y += 1) { if (grid[y]) { grid[y][cx0] = '│'; grid[y][cx1] = '│'; } }
    if (grid[cy0]) { grid[cy0][cx0] = '┌'; grid[cy0][cx1] = '┐'; }
    if (grid[cy1]) { grid[cy1][cx0] = '└'; grid[cy1][cx1] = '┘'; }
  }
  rects.forEach((r, i) => {
    const g = i < GLYPHS.length ? GLYPHS[i] : '#';
    legend.push([g, r.id]);
    const cx0 = Math.floor((r.x - x0) / scale); const cx1 = Math.min(gw - 1, Math.max(cx0, Math.ceil((r.x + r.w - x0) / scale) - 1));
    const cy0 = Math.floor((r.y - y0) / (scale * 2)); const cy1 = Math.min(gh - 1, Math.max(cy0, Math.ceil((r.y + r.h - y0) / (scale * 2)) - 1));
    for (let y = cy0; y <= cy1; y += 1) for (let x = cx0; x <= cx1; x += 1) if (grid[y]) grid[y][x] = g;
  });
  return {
    grid: grid.map(row => row.join('')).join('\n'),
    legend,
    bbox: { x: Math.round(x0), y: Math.round(y0), w: Math.round(W), h: Math.round(H) },
    cell: Math.round(scale),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * 相对位置（2026-08-23 晚，用户问「我们有没有告诉 agent 各模块的相对位置」——没有，
 * 之前只给绝对坐标和一张小地图；模型对"组 2 在组 1 左侧、同高"这种话的理解远好于
 * 读坐标）。下面把组的包围盒之间、组与用户视口之间的关系说成人话；组内再认一下
 * 列（x 聚类）给出阅读顺序提示。
 * ──────────────────────────────────────────────────────────────────────── */

export { bboxOf as bboxOfRects } from './rect.js';

/** b 相对 a 在哪（以 a 为参照）：左/右/上/下 + 距离；重叠则说重叠 */
export function relationOf(a, b) {
  if (!a || !b) return null;
  const gapX = b.x >= a.x + a.w ? b.x - (a.x + a.w) : (b.x + b.w <= a.x ? a.x - (b.x + b.w) : -1);
  const gapY = b.y >= a.y + a.h ? b.y - (a.y + a.h) : (b.y + b.h <= a.y ? a.y - (b.y + b.h) : -1);
  if (gapX < 0 && gapY < 0) return '重叠';
  const horiz = gapX >= 0 && (gapY < 0 || gapX >= gapY);
  if (horiz) {
    const side = b.x >= a.x + a.w ? '右侧' : '左侧';
    const vAlign = Math.abs(b.y - a.y) < 60 ? '顶齐' : (b.y > a.y ? '偏下' : '偏上');
    return `${side} ${Math.round(gapX)}px（${vAlign}）`;
  }
  const side = b.y >= a.y + a.h ? '下方' : '上方';
  const hAlign = Math.abs(b.x - a.x) < 60 ? '左齐' : (b.x > a.x ? '偏右' : '偏左');
  return `${side} ${Math.round(gapY)}px（${hAlign}）`;
}

/** 组内的列：按左边缘聚类（容差 60px），返回每列的成员数（自左向右） */
export function columnsOf(rects) {
  const xs = [...rects].sort((a, b) => a.x - b.x);
  const cols = [];
  for (const r of xs) {
    const c = cols.find(k => Math.abs(k.x - r.x) < 60);
    if (c) { c.n += 1; c.x = (c.x * (c.n - 1) + r.x) / c.n; } else cols.push({ x: r.x, n: 1 });
  }
  return cols;
}

/** 视口与一块区域的关系 */
export function viewportRelation(vp, box) {
  if (!vp || !box) return null;
  const ix = Math.max(0, Math.min(vp.x + vp.w, box.x + box.w) - Math.max(vp.x, box.x));
  const iy = Math.max(0, Math.min(vp.y + vp.h, box.y + box.h) - Math.max(vp.y, box.y));
  const cover = (ix * iy) / Math.max(1, box.w * box.h);
  if (cover >= 0.95) return '整块在用户视口里';
  if (cover > 0) return `用户视口盖住它约 ${Math.round(cover * 100)}%`;
  return `在用户视口之外（视口${relationOf(box, vp) || '别处'}）`;
}
