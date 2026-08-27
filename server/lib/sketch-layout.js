/**
 * server/lib/sketch-layout.js —— 黑板草图的排布与笔迹（2026-08-23）
 *
 * sketch_on_board 一次落一整张图：agent 说的是**结构**（节点、形状、线、模板、
 * 局部网格坐标），这里把它翻译成世界像素和 SVG 路径。两层拆开是这件事的核心：
 *   - 宏观落位（图落在无限画布哪里）归服务端：锚点旁 / 内容底下
 *   - 微观排布（图里面怎么摆）归 agent：模板 + 离散网格（1 格 = UNIT px）
 * 模型对连续坐标的空间推理弱、对小网格和"谁在谁右边"强，所以给的是网格不是像素。
 *
 * 形状（rect/ellipse/line/arrow/underline/circle/path）落成普通 scribble 对象：
 * 路径在这里生成，带确定性的手绘抖动（种子 = 形状 id），前端一个字不用改。
 * 路径只用 M/L/Q（board-sanitize 的字符白名单），数字保留一位小数。
 *
 * 全是纯函数；尺寸估算与 create-on-board 同一套公式。
 */

import { UNIT, overlaps, bboxOf as rectBbox } from './rect.js';
export { UNIT };                   // 兼容出口（真身在 rect.js）
/**
 * 可读性规范（2026-08-23，用户定）：黑板上的字要在 80%~100% 缩放下清晰可读。
 * 手写/md 正文 16px 世界像素在 0.8 倍下是 12.8 屏幕像素 —— 这是底线，所以节点
 * 字号不低于 md；一张图的尺寸要能在 0.8 倍下整张进一个普通视口（1400×900 屏
 * ≈ 1750×1125 世界像素）。超过 SKETCH_MAX 直接拒：一张图说一件事，大了就拆。
 */
export const SKETCH_FIT = { w: 1700, h: 1100 };   // 推荐上限（0.8 倍一屏）
export const SKETCH_MAX = { w: 2600, h: 1700 };   // 硬上限（再大就拆成两张）
export const GAP = 16;             // 模板排布的节点间距
const SIZE_PX = { sm: 13, md: 16, lg: 22, xl: 30 };

/** 手写字身位估算（抄 create-on-board / 前端 handleCreateText 同款） */
export function textBox(t, sizeKey, { md = false, wUnits = null } = {}) {
  const px = SIZE_PX[sizeKey] || 16;
  if (md) {
    const raw = String(t);
    const lines = raw.split('\n');
    // 字宽按 em 估：CJK/全角 1em，其余 0.62em（"12 个汉字 200px 装不下"就是这么来的）
    const em = (l) => [...l].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 1 : 0.62), 0);
    const longest = Math.max(8, ...lines.map(em));
    const w = wUnits ? wUnits * UNIT : Math.min(440, Math.max(200, Math.round(longest * px) + 24));
    const colsEm = Math.max(8, (w - 12) / px);
    // 渲染侧（MdInk）单换行 = 真换行，所以按源码行数估；空行 = 段落间距（GAP.sm≈8）；
    // 行高 1.6、上下 padding 4+4。前端还会把真实高度回写（useMeasuredSize），这里只求落位时别差太多
    let n = 0; let paras = 0;
    for (const l of lines) {
      if (!l.trim()) { paras += 1; continue; }
      n += Math.max(1, Math.ceil(em(l.replace(/[*_`#>]/g, '')) / colsEm));
    }
    // mermaid 盒子：横向（LR/RL）矮、纵向按语句数长；都只是估，真高度由渲染定
    const mm = raw.match(/```mermaid\n([\s\S]*?)```/);
    if (mm) {
      const body = mm[1].split('\n').filter(l => l.trim()).length;
      n += /\b(LR|RL)\b/.test(mm[1]) ? 3 : Math.max(4, body * 1.6);
    }
    return { w, h: Math.round(n * px * 1.6) + 8 + paras * 8 };
  }
  const cols = wUnits ? Math.max(4, Math.floor((wUnits * UNIT) / (px * 1.05))) : Math.min(26, Math.max(6, t.length));
  const lines = Math.ceil(t.length / cols) + (t.match(/\n/g)?.length || 0);
  return { w: wUnits ? wUnits * UNIT : Math.round(cols * px * 1.05) + 12, h: Math.round(lines * px * 1.6) + 10 };
}

/* ── 确定性随机（与前端 board-bindings 同款 FNV + mulberry32）── */
function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f1 = (n) => (Math.round(n * 10) / 10).toString();

/** 手绘一段：两点之间微抖的折线（带一点弧），返回 "L x y ..." 片段（不含起点 M） */
function wobblySeg(rand, a, b, amp = 1.2) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; const ny = dx / len;
  const segs = Math.max(2, Math.min(12, Math.round(len / 26)));
  const bow = (rand() * 2 - 1) * Math.min(len * 0.03, 3);
  let out = '';
  for (let i = 1; i <= segs; i += 1) {
    const t = i / segs;
    const w = i === segs ? 0 : amp * (rand() * 2 - 1) + Math.sin(Math.PI * t) * bow;
    out += ` L ${f1(a.x + dx * t + nx * w)} ${f1(a.y + dy * t + ny * w)}`;
  }
  return out;
}

/**
 * 形状 → { d, w, h }（路径相对形状包围盒左上角，pad 留 6px 给抖动和线宽）。
 * 输入尺寸是像素（调用方已把网格换成像素）。
 */
export function shapePath(kind, { w = 0, h = 0, to = null, d = null } = {}, seed = 'shape') {
  const rand = rng(hashSeed(seed));
  const P = 6;
  if (kind === 'path') {
    // 自由路径：agent 给的局部像素坐标，只做字符白名单与平移（调用方算 bbox）
    return { d: String(d || ''), w, h };
  }
  if (kind === 'line' || kind === 'arrow' || kind === 'underline') {
    // 从 (0,0) 到 (to.x,to.y) 的一笔；underline 是水平的 line 别名
    const tx = to?.x ?? w; const ty = kind === 'underline' ? 0 : (to?.y ?? 0);
    const minX = Math.min(0, tx); const minY = Math.min(0, ty);
    const a = { x: P - minX, y: P - minY }; const b = { x: tx + P - minX, y: ty + P - minY };
    let path = `M ${f1(a.x)} ${f1(a.y)}${wobblySeg(rand, a, b)}`;
    if (kind === 'arrow') {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len; const uy = (b.y - a.y) / len;
      const L = Math.min(14, Math.max(8, len * 0.12));
      const wing = (s) => ({ x: b.x - ux * L + (-uy) * s * L * 0.55, y: b.y - uy * L + ux * s * L * 0.55 });
      const w1 = wing(1); const w2 = wing(-1);
      path += ` M ${f1(w1.x)} ${f1(w1.y)}${wobblySeg(rand, w1, b, 0.6)} M ${f1(w2.x)} ${f1(w2.y)}${wobblySeg(rand, w2, b, 0.6)}`;
    }
    return { d: path, w: Math.abs(tx) + P * 2, h: Math.abs(ty) + P * 2 };
  }
  if (kind === 'rect') {
    const x0 = P; const y0 = P; const x1 = P + w; const y1 = P + h;
    const c = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    // 角上微微出头（手画的框角会交叉），起笔点随机落在四角之一
    let path = `M ${f1(c[0].x - 1)} ${f1(c[0].y)}`;
    for (let i = 0; i < 4; i += 1) path += wobblySeg(rand, c[i], c[(i + 1) % 4]);
    path += ` L ${f1(c[0].x + 3)} ${f1(c[0].y + 0.5)}`;
    return { d: path, w: w + P * 2, h: h + P * 2 };
  }
  if (kind === 'ellipse' || kind === 'circle') {
    const rx = w / 2; const ry = (kind === 'circle' ? w : h) / 2;
    const cx = P + rx; const cy = P + ry;
    const n = Math.max(16, Math.min(48, Math.round((rx + ry) / 6)));
    const amp = Math.min(1.6, 0.5 + (rx + ry) / 300);
    let path = '';
    // 多画 1/8 圈让起止重叠，像手画的圈
    for (let i = 0; i <= n + n / 8; i += 1) {
      const t = (i / n) * Math.PI * 2 - Math.PI / 3;
      const jitter = 1 + (rand() * 2 - 1) * amp / Math.max(rx, ry);
      const x = cx + Math.cos(t) * rx * jitter; const y = cy + Math.sin(t) * ry * jitter;
      path += (i === 0 ? 'M ' : ' L ') + `${f1(x)} ${f1(y)}`;
    }
    return { d: path, w: rx * 2 + P * 2, h: ry * 2 + P * 2 };
  }
  return null;
}

/**
 * 模板排布。nodes: [{ key, w, h, at?: {x,y}(网格) }] → Map key → {x,y}（局部像素）
 * - free：有 at 的按网格落，没 at 的排在 free 区域下面一列
 * - column / row / grid(cols) / mindmap（第一个是中心，其余环绕）
 */
/**
 * 模板解析（08-27 抽出，write-on-board 与 layoutNodes 共用一份 auto 规则）。
 * ⭐ auto 现在**认线**：图内边 ≥1 且节点 ≥3 → flow（按结构分层）。在这之前
 * 布局引擎对 edges 全盲 —— 给了线也按 column/grid 堆，「摊一堆字」的机器根源。
 */
export function resolveTemplate(nodes, { template = 'auto', edges = [] } = {}) {
  if (template !== 'auto') return template;
  if (nodes.some(n => n.at)) return 'free';
  const keys = new Set(nodes.map(n => n.key));
  const inner = edges.filter(e => keys.has(e.from) && keys.has(e.to) && e.from !== e.to);
  if (inner.length && nodes.length >= 3) return 'flow';
  return nodes.length <= 4 ? 'column' : 'grid';
}

/** 分层流式（Sugiyama 简版）：层号=最长入路径（模型画的图可能带环，深度截断兜住），
 *  层内按父级平均横位排（减少交叉），每层居中。线因此顺着重力方向读。 */
function layoutFlow(nodes, edges, pull = new Map()) {
  const pos = new Map();
  const idx = new Map(nodes.map((n, i) => [n.key, i]));
  const level = new Map();
  const depth = (k, seen) => {
    if (level.has(k)) return level.get(k);
    if (seen.has(k)) return 0;                       // 环：断在回边上
    seen.add(k);
    let best = 0;
    for (const e of edges) if (e.to === k) best = Math.max(best, depth(e.from, seen) + 1);
    seen.delete(k);
    level.set(k, best);
    return best;
  };
  for (const n of nodes) depth(n.key, new Set());
  const layers = [];
  for (const n of nodes) { const l = level.get(n.key) || 0; (layers[l] ||= []).push(n); }
  const centerX = new Map();
  let y = 0;
  for (const layer of layers) {
    if (!layer) continue;
    const parentAvg = (k) => {
      const ps = edges.filter(e => e.to === k && centerX.has(e.from)).map(e => centerX.get(e.from));
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : idx.get(k) * 10;
    };
    // 节点级拉力（08-27 产物锚 v2）：连着外部产物的节点排向产物那一侧。
    // 外部锚是世界坐标、parentAvg 是局部坐标，不同尺度 —— 各自归一到 [0,1] 再比。
    const norm = (vals) => {
      const lo = Math.min(...vals); const hi = Math.max(...vals);
      return (v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
    };
    const pulled = layer.filter((n) => pull.has(n.key));
    const nExt = pulled.length ? norm(pulled.map((n) => pull.get(n.key).x)) : null;
    const paVals = layer.filter((n) => !pull.has(n.key)).map((n) => parentAvg(n.key));
    const nPa = paVals.length ? norm(paVals) : null;
    const score = (n) => (pull.has(n.key) ? nExt(pull.get(n.key).x) : (nPa ? nPa(parentAvg(n.key)) : 0.5));
    layer.sort((a, b) => (score(a) - score(b)) || (idx.get(a.key) - idx.get(b.key)));
    const totalW = layer.reduce((s, n) => s + n.w, 0) + (layer.length - 1) * (GAP * 2 + 8);
    let x = Math.round(-totalW / 2);
    let rowH = 0;
    for (const n of layer) {
      pos.set(n.key, { x, y });
      centerX.set(n.key, x + n.w / 2);
      x += n.w + GAP * 2 + 8; rowH = Math.max(rowH, n.h);
    }
    y += rowH + GAP * 3;                              // 层间留出画箭头的呼吸
  }
  return pos;
}

export function layoutNodes(nodes, { template = 'auto', cols = null, edges = [], pull = new Map(), pullOrigin = null } = {}) {
  const pos = new Map();
  if (!nodes.length) return pos;
  const keys = new Set(nodes.map(n => n.key));
  const inner = edges.filter(e => keys.has(e.from) && keys.has(e.to) && e.from !== e.to);
  const tpl = resolveTemplate(nodes, { template, edges });
  if (tpl === 'flow') return layoutFlow(nodes, inner, pull);

  if (tpl === 'free') {
    let bottom = 0;
    const rest = [];
    for (const n of nodes) {
      if (n.at && Number.isFinite(n.at.x) && Number.isFinite(n.at.y)) {
        const p = { x: Math.round(n.at.x * UNIT), y: Math.round(n.at.y * UNIT) };
        pos.set(n.key, p); bottom = Math.max(bottom, p.y + n.h);
      } else rest.push(n);
    }
    let y = bottom ? bottom + GAP : 0;
    for (const n of rest) { pos.set(n.key, { x: 0, y }); y += n.h + GAP; }
    return pos;
  }
  if (tpl === 'column') {
    let y = 0;
    for (const n of nodes) { pos.set(n.key, { x: 0, y }); y += n.h + GAP; }
    return pos;
  }
  if (tpl === 'row') {
    let x = 0;
    for (const n of nodes) { pos.set(n.key, { x, y: 0 }); x += n.w + GAP + 4; }
    return pos;
  }
  if (tpl === 'mindmap') {
    // 枢纽按度数选、环序按 BFS 排（08-27）：在这之前中心=第一个节点、环上按入参
    // 顺序 —— 结构全被扔掉，同父的孩子散在环两端，线横穿整张图
    let order = nodes;
    if (inner.length) {
      const deg = new Map(nodes.map(n => [n.key, 0]));
      const adj = new Map(nodes.map(n => [n.key, []]));
      for (const e of inner) {
        deg.set(e.from, deg.get(e.from) + 1); deg.set(e.to, deg.get(e.to) + 1);
        adj.get(e.from).push(e.to); adj.get(e.to).push(e.from);
      }
      const hub = [...nodes].sort((a, b) => deg.get(b.key) - deg.get(a.key))[0];
      const seen = new Set([hub.key]); const q = [hub.key]; const bfs = [];
      while (q.length) {
        const k = q.shift();
        for (const nk of adj.get(k) || []) if (!seen.has(nk)) { seen.add(nk); bfs.push(nk); q.push(nk); }
      }
      const byKey = new Map(nodes.map(n => [n.key, n]));
      order = [hub, ...bfs.map(k => byKey.get(k)), ...nodes.filter(n => !seen.has(n.key))];
    }
    let [center, ...rest] = order;
    // 节点级拉力（08-27 产物锚 v2）：连着外部产物的叶子占朝着那个产物的环位 ——
    // 立绘在上方，评它的节点就在环的上侧，线不再绕半圈。质心=全部外部锚的平均
    // （图会落在它们旁边，质心是图心的够用近似）。
    // 方位原点：pullOrigin = 图心的世界坐标（落位后由调用方二次布局传入 ——
    // 环形 bbox 不随槽位变，二次布局不动落位）。没有它就退回锚质心；
    // 锚全挤在一点时质心=锚本身、方向向量退化 → 放弃重排（bfs 序保底）。
    let origin = pullOrigin;
    if (!origin) {
      const pts = [...pull.values()];
      const cx0 = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy0 = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const spread = Math.max(...pts.map((p) => Math.hypot(p.x - cx0, p.y - cy0)));
      origin = spread > 1 ? { x: cx0, y: cy0 } : null;
    }
    if (origin && pull.size && rest.some((n) => pull.has(n.key))) {
      const slotAng = (i) => (i / rest.length) * Math.PI * 2 - Math.PI / 2;
      const free = new Set(rest.map((_, i) => i));
      const assigned = new Array(rest.length).fill(null);
      const angDist = (a, b) => { const d = Math.abs(a - b) % (Math.PI * 2); return Math.min(d, Math.PI * 2 - d); };
      for (const n of rest) {
        if (!pull.has(n.key)) continue;
        const p = pull.get(n.key);
        const want = Math.atan2(p.y - origin.y, p.x - origin.x);
        let best = null;
        for (const i of free) if (best === null || angDist(slotAng(i), want) < angDist(slotAng(best), want)) best = i;
        assigned[best] = n; free.delete(best);
      }
      const others = rest.filter((n) => !pull.has(n.key));
      let j = 0;
      for (const i of [...free].sort((a, b) => a - b)) { assigned[i] = others[j++]; }
      rest = assigned;
    }
    const cx = 0; const cy = 0;
    pos.set(center.key, { x: cx - center.w / 2, y: cy - center.h / 2 });
    if (!rest.length) return pos;
    // 半径：中心节点（含可能套在外面的圈）之外留 70，且环的周长要摆得下所有节点
    const need = rest.reduce((sum, n) => sum + Math.max(n.w, 120) + GAP * 2, 0);
    const r = Math.max(center.w / 2 + 70, center.h / 2 + 70, need / (Math.PI * 2) + 40);
    rest.forEach((n, i) => {
      const t = (i / rest.length) * Math.PI * 2 - Math.PI / 2;
      const c = Math.cos(t); const sn = Math.sin(t);
      // 节点**靠内的那条边**落在环上（不是节点中心）：宽节点才不会压进中心
      pos.set(n.key, {
        x: Math.round(cx + c * r - n.w * (1 - c) / 2),
        y: Math.round(cy + sn * r * 0.72 - n.h * (1 - sn) / 2),
      });
    });
    return pos;
  }
  // grid
  const c = Math.max(1, cols || Math.ceil(Math.sqrt(nodes.length)));
  const colW = Array(c).fill(0);
  nodes.forEach((n, i) => { colW[i % c] = Math.max(colW[i % c], n.w); });
  let y = 0; let rowH = 0;
  nodes.forEach((n, i) => {
    const col = i % c;
    if (col === 0 && i > 0) { y += rowH + GAP; rowH = 0; }
    let x = 0; for (let k = 0; k < col; k += 1) x += colW[k] + GAP + 4;
    pos.set(n.key, { x, y }); rowH = Math.max(rowH, n.h);
  });
  return pos;
}

/** 一组矩形的包围盒。⚠️ 这里的空集契约是**零框**不是 null（写方直接解构 .x/.w），
 *  真身在 rect.js（那边空集 null），这层壳只兜语义差。 */
export function bboxOf(rects) {
  return rectBbox(rects) || { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * 宏观落位：在 obstacles（同层已摆的矩形）中给一块 w×h 找地方。
 * - near：锚右侧（撞了往下让），让不开就锚下方
 * - 否则：内容最低边下面（与入座"新东西排底下"同一条起排线精神）
 */
export function findSpot({ w, h, near = null, obstacles = [], contentBottom = 0, viewport = null }) {
  const hits = (x, y) => obstacles.some(o => overlaps({ x, y, w, h }, o));
  // 用户视口里有空地就落在视口里（黑板是主窗口时，画在他眼前而不是让他去找）。
  // 阅读顺序纪律（08-23 真踩：第二张图落到第一张的**左边**）：先挑不在已有内容左侧/
  // 上方的位置（顺着先左后右、先上后下长），实在没有才退而求其次。
  if (!near && viewport && viewport.w >= w + 24 && viewport.h >= h + 24) {
    const content = obstacles.length ? {
      x: Math.min(...obstacles.map(o => o.x)), y: Math.min(...obstacles.map(o => o.y)),
    } : null;
    const sx = Math.max(24, Math.round(viewport.w / 8)); const sy = Math.max(24, Math.round(viewport.h / 8));
    for (const strict of [true, false]) {
      for (let y = viewport.y + 12; y + h <= viewport.y + viewport.h - 12; y += sy) {
        for (let x = viewport.x + 12; x + w <= viewport.x + viewport.w - 12; x += sx) {
          if (strict && content && (x < content.x - 24 || y < content.y - 24)) continue;
          if (!hits(x, y)) return { x: Math.round(x), y: Math.round(y), side: 'viewport' };
        }
      }
    }
  }
  if (near) {
    let x = near.x + near.w + 32; let y = near.y;
    for (let g = 0; g < 30; g += 1) {
      if (!hits(x, y)) return { x: Math.round(x), y: Math.round(y), side: 'right' };
      const blocker = obstacles.find(o => !(x + w <= o.x || o.x + o.w <= x || y + h <= o.y || o.y + o.h <= y));
      y = blocker.y + blocker.h + GAP;
    }
    x = near.x; y = near.y + near.h + 32;
    for (let g = 0; g < 30; g += 1) {
      if (!hits(x, y)) return { x: Math.round(x), y: Math.round(y), side: 'below' };
      const blocker = obstacles.find(o => !(x + w <= o.x || o.x + o.w <= x || y + h <= o.y || o.y + o.h <= y));
      y = blocker.y + blocker.h + GAP;
    }
  }
  // 排在内容底下：左边缘对齐已有内容（不是写死的 10），读起来像续在同一栏
  const left = obstacles.length ? Math.min(...obstacles.map(o => o.x)) : 10;
  return { x: Math.round(left), y: Math.round(contentBottom) + 40, side: 'bottom' };
}

/**
 * 按用户屏幕算「一屏」：视点里有相机矩形和缩放 → 屏幕像素 = 世界 × 缩放；
 * 0.8 倍可读 → 一屏世界像素 = 屏幕 / 0.8。没视点就用 SKETCH_FIT 的缺省。
 */
export function fitFor(vp) {
  if (vp?.camera?.w && vp?.zoom) {
    const sw = vp.camera.w * vp.zoom; const sh = vp.camera.h * vp.zoom;
    return { w: Math.round(sw / 0.8), h: Math.round(sh / 0.8), screen: { w: Math.round(sw), h: Math.round(sh) } };
  }
  return { ...SKETCH_FIT, screen: null };
}
