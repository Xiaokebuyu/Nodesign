/**
 * lib/line-route.js —— 关系线绕开中间的卡片（2026-09-11）
 *
 * 09-11 量桌面真会话：agent 删掉的 9 条线全在看过板之后 —— 一列里跳过中间节点的线（c1→c5）
 * 从中间几张卡上直穿过去。画线只避开两端（edgePoints），中间谁挡着不管。
 *
 * 一条线 = 两个端点 + 一个二次贝塞尔控制点。默认那条（边界点 + 各材质的微拱）不穿就用它；穿了：
 *   1. 先试「从侧边出、从侧边进」：竖着的线走两张卡的左 / 右边，横着的走上 / 下边，往外轻轻拱。
 *      从卡片正中出发的线躲不开紧挨着的下一张（二次曲线在端点附近几乎沿弦走），换端点才躲得开。
 *   2. 再试原端点加大弯度（斜线多半这样就够）。
 *   3. 都穿就保持默认，报穿了谁。
 *
 * ⚠️ 前端 web/src/lib/line-route.js 是同一份算法（画线用），web/src/lib/line-route.parity.test.js
 * 逐样本对账 —— 改一边忘另一边直接红。服务端这份用来在返回里如实报「绕不开的线」。
 */
import { estimateSizeOn } from './board-kind-sizes.js';
import { layerOf } from './canvas-id.js';

export const SIDE_OFFSETS = [40, 80, 140, 220, 320, 440];
export const DETOUR_OFFSETS = [80, 140, 220, 320, 440, 600];
const SAMPLES = 24;
const PAD = 4;

/** 线的两个端点：从各自矩形的边界出发（跟前端 board-bindings.edgePoints 逐字一致） */
export function edgePoints(a, b, gap = 6) {
  if (!a || !b) return null;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return null;
  return { from: rectEdgePoint(a, ac, dx, dy, gap), to: rectEdgePoint(b, bc, -dx, -dy, gap) };
}
function rectEdgePoint(rect, center, dx, dy, gap) {
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  const len = Math.hypot(dx, dy) || 1;
  return { x: center.x + dx * t + (dx / len) * gap, y: center.y + dy * t + (dy / len) * gap };
}

/** 各材质的默认控制点（ink / pencil 微拱，yarn 下垂 —— 跟前端三种几何同一套数） */
export function baseControl(from, to, material = 'ink') {
  const dx = to.x - from.x; const dy = to.y - from.y; const dist = Math.hypot(dx, dy) || 1;
  if (material === 'yarn') {
    const sag = Math.min(dist * 0.11, 56) * (0.25 + 0.75 * (Math.abs(dx) / dist));
    return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + sag };
  }
  const lift = Math.min(dist * 0.14, 46);
  return { x: (from.x + to.x) / 2 + (-dy / dist) * lift, y: (from.y + to.y) / 2 + (dx / dist) * lift };
}

const qPoint = (p0, c, p1, t) => ({ x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x, y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y });

/** 线段与矩形相交（Liang–Barsky 裁剪） */
function segHitsRect(p, q, r) {
  let t0 = 0; let t1 = 1;
  const dx = q.x - p.x; const dy = q.y - p.y;
  const clip = (pp, qq) => {
    if (pp === 0) return qq >= 0;
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, p.x - r.x) && clip(dx, r.x + r.w - p.x) && clip(-dy, p.y - r.y) && clip(dy, r.y + r.h - p.y) && t0 <= t1;
}

/** 这条曲线穿过了哪些矩形（rects: [{id,x,y,w,h}]，两端自己别放进来） */
export function curveHits(from, c, to, rects) {
  const pts = [];
  for (let i = 0; i <= SAMPLES; i += 1) pts.push(qPoint(from, c, to, i / SAMPLES));
  const hit = [];
  for (const r of rects) {
    const R = { x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 };
    for (let i = 0; i < SAMPLES; i += 1) if (segHitsRect(pts[i], pts[i + 1], R)) { hit.push(r.id); break; }
  }
  return hit;
}

/** 矩形某一侧边的中点再往外让 gap（d = 朝外的单位方向） */
const edgeMid = (r, d, gap) => (d.x ? { x: d.x > 0 ? r.x + r.w + gap : r.x - gap, y: r.y + r.h / 2 } : { x: r.x + r.w / 2, y: d.y > 0 ? r.y + r.h + gap : r.y - gap });

/**
 * 一条线怎么画：a / b 是两端的矩形。
 * @returns {{ from, to, ctrl, crossed:string[], detoured:boolean } | null}
 */
export function routeLine(a, b, material, rects, gap = 6) {
  const pts = edgePoints(a, b, gap);
  if (!pts) return null;
  const base = baseControl(pts.from, pts.to, material);
  const hit0 = rects.length ? curveHits(pts.from, base, pts.to, rects) : [];
  if (!hit0.length) return { from: pts.from, to: pts.to, ctrl: base, crossed: [], detoured: false };
  const ok = (from, ctrl, to) => !curveHits(from, ctrl, to, rects).length;
  const dx = pts.to.x - pts.from.x; const dy = pts.to.y - pts.from.y; const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist; const ny = dx / dist;
  const mx = (pts.from.x + pts.to.x) / 2; const my = (pts.from.y + pts.to.y) / 2;
  const lean = Math.sign((base.x - mx) * nx + (base.y - my) * ny) || 1;
  // 1. 侧边出、侧边进（先试默认拱的那一侧）
  const vertical = Math.abs((b.y + b.h / 2) - (a.y + a.h / 2)) >= Math.abs((b.x + b.w / 2) - (a.x + a.w / 2));
  const first = (vertical ? Math.sign(nx * lean) : Math.sign(ny * lean)) || 1;
  // 侧边端点离边正好 gap（比检测外扩多 2px），所以两端自己也能当障碍查 —— 贴着终点的边横着进来会切进它的角
  const ends = [{ ...a, id: '(from)' }, { ...b, id: '(to)' }];
  for (const s of [first, -first]) {
    const d = vertical ? { x: s, y: 0 } : { x: 0, y: s };
    const from = edgeMid(a, d, gap); const to = edgeMid(b, d, gap);
    for (const off of SIDE_OFFSETS) {
      const c = { x: (from.x + to.x) / 2 + d.x * off, y: (from.y + to.y) / 2 + d.y * off };
      if (!curveHits(from, c, to, [...rects, ...ends]).length) return { from, to, ctrl: c, crossed: [], detoured: true };
    }
  }
  // 2. 原端点加大弯度
  for (const off of DETOUR_OFFSETS) {
    for (const s of [lean, -lean]) {
      const c = { x: mx + nx * off * s, y: my + ny * off * s };
      if (ok(pts.from, c, pts.to)) return { from: pts.from, to: pts.to, ctrl: c, crossed: [], detoured: true };
    }
  }
  return { from: pts.from, to: pts.to, ctrl: base, crossed: hit0, detoured: false };
}

/** 只留可能挡路的：两端矩形合起来的包围盒，外扩到最大绕行幅度够得着的范围 */
export function nearLine(a, b, rects) {
  const m = Math.max(DETOUR_OFFSETS[DETOUR_OFFSETS.length - 1], SIDE_OFFSETS[SIDE_OFFSETS.length - 1]) / 2 + PAD * 4;
  const x1 = Math.min(a.x, b.x) - m; const x2 = Math.max(a.x + a.w, b.x + b.w) + m;
  const y1 = Math.min(a.y, b.y) - m; const y2 = Math.max(a.y + a.h, b.y + b.h) + m;
  return rects.filter((r) => r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1);
}

/** 贴着的两件不画线（跟前端 BindingLayer 的 ADJACENT_PX 同口径） */
const ADJACENT_PX = 24;
const gapBetween = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

/**
 * 返回里要报的「绕不开的线」：只看这次动过的东西连着的线 + 这次新画的线。
 * @returns {string[]}  每条一句，最多 5 条
 */
export function lineCrossings(b, { objectIds = [], bindingIds = [] } = {}, known = new Set()) {
  const touched = new Set(objectIds); const wanted = new Set(bindingIds);
  const rectOf = (id) => { const e = b.objects?.[id]; return e && Number.isFinite(e.x) ? { id, x: e.x, y: e.y, ...estimateSizeOn(b, id, e) } : null; };
  const all = Object.keys(b.objects || {}).filter((id) => b.objects[id]?.kind !== 'scribble').map(rectOf).filter(Boolean);
  const notes = [];
  for (const [bid, x] of Object.entries(b.bindings || {})) {
    if (!x || !(wanted.has(bid) || touched.has(x.from) || touched.has(x.to))) continue;
    if (x.by === 'auto' && x.type === 'ref') continue;          // 自动取材边前端不画
    const a = rectOf(x.from); const z = rectOf(x.to);
    if (!a || !z || gapBetween(a, z) <= ADJACENT_PX) continue;
    const layer = layerOf(x.from, b.objects[x.from], known);
    const obstacles = nearLine(a, z, all.filter((r) => r.id !== x.from && r.id !== x.to && layerOf(r.id, b.objects[r.id], known) === layer));
    const r = routeLine(a, z, x.material, obstacles);
    if (r?.crossed.length) {
      notes.push(`⚠ 线 ${bid}（${x.from} → ${x.to}）绕不开，横穿了 ${r.crossed.length} 件：${r.crossed.slice(0, 3).join('、')} —— 把两端挪近（或 reflow），或者这层关系用挨着摆来表达`);
    }
  }
  return notes.slice(0, 5);
}
