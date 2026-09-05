/**
 * lib/board-place.js —— 意图层落位求解器（2026-09-05 板书重定位）
 *
 * ## 为什么
 *
 * 纸范式（2026-08-29 至 09-04）让 agent 用纸内像素说位置：at:{x,y}、版位 w/h、
 * 预约高度 h。近 14 天 261 份真会话转录里，write_on_board 的 230 次硬失败约 170 次
 * 是同一句「差 N 像素、约 N 行」—— agent 在做一道它做不准的算术（一段字落下去有多高）。
 * 机械那层（避碰、钳制、压住谁如实报）是好的，坏在收单的语言。
 *
 * ## 现在
 *
 * agent 只说**关系**：贴着谁（by）、哪一侧（side，偏好不是命令）、跟哪一组（with）、
 * 落在用户视口（view，缺省）。像素由这里解出来，永远不拒收：要的位置放不下就换最近
 * 的空位并如实报「放在了 A 下面不是右边」。框由内容撑开，没有「差 N 像素」这种失败。
 *
 * 纯函数：吃 board 派生出来的障碍矩形，不读盘不落盘。锚点解析（id / #tag / 路径 /
 * user / view）在调用方（lib/board-anchor.js + 各工具）。
 */
import { UNIT, overlaps } from './rect.js';
import { ROLE_SLUG_RE } from '../engine/agent/cast.js';

export const SIDES = Object.freeze(['right', 'left', 'below', 'above']);
/** 沿锚点滑动找空位时最多滑多远（格） */
const SLIDE_UNITS = 8;
/** 螺旋搜最近空位的最大半径（格） */
const SPIRAL_UNITS = 40;

/** 贴放：不搜空位，纯几何（题注必须在上方那类语义用它） */
export function placeBeside(anchor, box, side = 'right', gap = UNIT) {
  const p = side === 'right' ? { x: anchor.x + anchor.w + gap, y: anchor.y }
    : side === 'left' ? { x: anchor.x - gap - box.w, y: anchor.y }
      : side === 'below' ? { x: anchor.x, y: anchor.y + anchor.h + gap }
        : { x: anchor.x, y: anchor.y - gap - box.h };
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** 压住了谁（报文用；limit 截断） */
export function overlapIds(rect, obstacles, { pad = 0, limit = 6 } = {}) {
  const out = [];
  for (const o of obstacles) {
    if (!overlaps(rect, o, pad)) continue;
    if (o.id) out.push(o.id);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 角色精灵的身位：每个角色最新那条板书四周留 pad，别的东西别贴上去
 * （精灵站在自己最新一条旁边，见 sprite-layer）。
 */
export function inflateSpriteSeats(obstacles, objects, pad = 60) {
  const last = new Map();
  for (const [id, e] of Object.entries(objects || {})) {
    if (typeof e?.by === 'string' && ROLE_SLUG_RE.test(e.by)) last.set(e.by, id);
  }
  if (!last.size) return obstacles;
  const ids = new Set(last.values());
  return obstacles.map((o) => (ids.has(o.id)
    ? { ...o, x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 }
    : o));
}

/** 折起的组只剩一张小卡占地（几何按组左上角 + 标签宽） */
export function rollCardRect(board, tag) {
  const roll = board?.rolls?.[tag];
  if (!roll) return null;
  const members = Object.entries(board?.objects || {}).filter(([, e]) => e?.tag === tag && Number.isFinite(e?.x));
  if (!members.length) return null;
  const x = Math.min(...members.map(([, e]) => e.x));
  const y = Math.min(...members.map(([, e]) => e.y));
  const label = String(roll.label || tag);
  const em = [...label].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.62), 0);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(48 + em * 15), h: 40 };
}

/**
 * 接楼：正下方一直往下找，被挡住就跳到那件底下。没有纸就没有底 —— 一条线要
 * 多长就多长（纸范式里的 floor 退役：那个 Infinity 是 09-01 失控自我延续的病根，
 * 现在明说没有底，且接楼只在 reply_to/chain 这一种关系里用）。
 */
export function placeBelow(replyRect, box, obstacles = [], gap = UNIT) {
  const x = Math.round(replyRect.x);
  let y = replyRect.y + replyRect.h + gap;
  for (let i = 0; i < 500; i += 1) {
    const r = { x, y, w: box.w, h: box.h };
    const hit = obstacles.find((o) => overlaps(r, o));
    if (!hit) return { x, y: Math.round(y) };
    y = hit.y + hit.h + gap;
  }
  return { x, y: Math.round(y) };
}

/** 同 tag 组里「最后一条」（阅读序：先下后右）—— with:<tag> 的续写锚 */
export function lastOfGroup(board, tag, sizeOf) {
  const hits = Object.entries(board?.objects || {}).filter(([, e]) => e?.tag === tag && Number.isFinite(e?.x));
  if (!hits.length) return null;
  let best = null;
  for (const [id, e] of hits) {
    const s = sizeOf(id, e) || { w: 0, h: 0 };
    const r = { id, x: e.x, y: e.y, w: s.w, h: s.h };
    if (!best || r.y + r.h > best.y + best.h || (r.y + r.h === best.y + best.h && r.x > best.x)) best = r;
  }
  return best;
}

const isFree = (r, obstacles) => !obstacles.some((o) => overlaps(r, o));

/** 沿锚点的一侧滑动找第一个空位（right/left 往下滑，below/above 往右滑） */
function slideAlong(anchor, box, side, obstacles, gap) {
  const base = placeBeside(anchor, box, side, gap);
  const vertical = side === 'right' || side === 'left';
  const span = vertical ? anchor.h : anchor.w;
  const maxSteps = Math.ceil(span / UNIT) + SLIDE_UNITS;
  for (let i = 0; i <= maxSteps; i += 1) {
    const p = vertical ? { x: base.x, y: base.y + i * UNIT } : { x: base.x + i * UNIT, y: base.y };
    if (isFree({ ...p, w: box.w, h: box.h }, obstacles)) return { ...p, slid: i > 0 };
  }
  return null;
}

/** 以锚点中心为圆心、按环序找最近空位 */
function spiralFrom(center, box, obstacles) {
  const cx = Math.round(center.x - box.w / 2); const cy = Math.round(center.y - box.h / 2);
  for (let ring = 1; ring <= SPIRAL_UNITS; ring += 1) {
    const cells = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        cells.push({ x: cx + dx * UNIT, y: cy + dy * UNIT, d: dx * dx + dy * dy });
      }
    }
    cells.sort((a, b) => a.d - b.d);
    for (const c of cells) if (isFree({ x: c.x, y: c.y, w: box.w, h: box.h }, obstacles)) return { x: c.x, y: c.y };
  }
  return null;
}

/** 视口里按阅读序（先上后下、先左后右）找第一个整块空地 */
function scanViewport(vp, box, obstacles, margin = UNIT) {
  const x0 = vp.x + margin; const y0 = vp.y + margin;
  const xMax = vp.x + vp.w - margin - box.w; const yMax = vp.y + vp.h - margin - box.h;
  if (yMax < y0) return null;                       // 比视口还高：视口里装不下整块
  const xs = [];
  if (xMax < x0) xs.push(x0); else for (let x = x0; x <= xMax; x += UNIT) xs.push(x);
  for (let y = y0; y <= yMax; y += UNIT) {
    for (const x of xs) if (isFree({ x, y, w: box.w, h: box.h }, obstacles)) return { x, y };
  }
  return null;
}

/** 内容底边（一层里所有障碍的最低点）与左沿 */
function contentEdges(obstacles, fallback = { x: UNIT, y: 0 }) {
  if (!obstacles.length) return { left: fallback.x, bottom: fallback.y };
  return {
    left: Math.min(...obstacles.map((o) => o.x)),
    bottom: Math.max(...obstacles.map((o) => o.y + o.h)),
  };
}

/**
 * 求解一个落位意图。
 *
 * @param {object} p
 * @param {{w:number,h:number}} p.box            要放的东西的尺寸（由内容撑开）
 * @param {{id?:string,x,y,w,h}|null} p.anchor   贴着谁（by / near 解析出的矩形）
 * @param {string|null} p.side                   偏好的一侧（缺省机器按空地选）
 * @param {{id?:string,x,y,w,h}|null} p.group    with:<tag> 解析出的组尾（续写落它下面）
 * @param {{x,y,w,h}|null} p.viewport            用户视口（同一层才给）
 * @param {Array<{id?:string,x,y,w,h}>} p.obstacles  这一层上占着地方的东西
 * @param {boolean} p.column                     手机档：只许上下，不并排
 * @returns {{x:number,y:number,how:string,side:string|null,nudged:boolean,wanted:string|null}}
 *   how ∈ beside | thread | in-view | below-view | near | below-content
 *   nudged=true 表示没落在偏好的那一侧或滑开了；wanted 是偏好的那一侧
 */
export function solvePlace({ box, anchor = null, side = null, group = null, viewport = null, obstacles = [], column = false, gap = UNIT }) {
  const wanted = side && SIDES.includes(side) ? side : null;
  // 续写：组尾正下方接楼（同一条线永远往下长）
  if (group) {
    const p = placeBelow(group, box, obstacles, gap);
    return { ...p, how: 'thread', side: 'below', nudged: false, wanted };
  }
  if (anchor) {
    const order = column
      ? ['below', 'above']
      : (wanted ? [wanted, ...SIDES.filter((s) => s !== wanted)] : ['right', 'below', 'left', 'above']);
    for (const s of order) {
      const p = slideAlong(anchor, box, s, obstacles, gap);
      if (p) return { x: p.x, y: p.y, how: 'beside', side: s, nudged: (wanted ? s !== wanted : false) || !!p.slid, wanted };
    }
    const sp = spiralFrom({ x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 }, box, obstacles);
    if (sp) return { ...sp, how: 'near', side: null, nudged: true, wanted };
    const { bottom } = contentEdges(obstacles);
    return { x: Math.round(anchor.x), y: Math.round(bottom + gap), how: 'below-content', side: null, nudged: true, wanted };
  }
  if (viewport) {
    const p = scanViewport(viewport, box, obstacles);
    if (p) return { ...p, how: 'in-view', side: null, nudged: false, wanted };
    // 视口里没有整块空地：贴着视口内容的底边往下（用户往下一滚就看见）
    const inView = obstacles.filter((o) => overlaps(o, viewport));
    const bottom = inView.length ? Math.max(...inView.map((o) => o.y + o.h)) : viewport.y + viewport.h;
    const x = Math.round(viewport.x + UNIT);
    const y = placeBelow({ x, y: bottom, w: box.w, h: 0 }, box, obstacles, gap).y;
    return { x, y, how: 'below-view', side: null, nudged: true, wanted };
  }
  const { left, bottom } = contentEdges(obstacles);
  return { x: Math.round(left), y: Math.round(bottom + (obstacles.length ? 40 : 0)), how: 'below-content', side: null, nudged: false, wanted };
}

/** 落位报文（给 agent 的一句话，只说关系不报像素） */
export function describePlacement(placed, { anchorId = null, groupTag = null } = {}) {
  const who = anchorId ? `${anchorId}` : 'the anchor';
  switch (placed.how) {
    case 'thread': return groupTag ? `continues #${groupTag} (under its last note)` : 'under the note it replies to (thread)';
    case 'beside': {
      const base = `${placed.side} of ${who}`;
      if (placed.wanted && placed.side !== placed.wanted) return `${base} (no room ${placed.wanted}, so it went ${placed.side})`;
      return placed.nudged ? `${base}, slid along to the nearest free spot` : base;
    }
    case 'near': return `near ${who} (no free side, nearest open spot)`;
    case 'in-view': return "in the user's current view, on free ground";
    case 'below-view': return "just below what the user is looking at (their view had no free ground)";
    case 'below-content': return anchorId ? `below everything, under ${who}` : 'below all current content';
    default: return placed.how || 'placed';
  }
}
