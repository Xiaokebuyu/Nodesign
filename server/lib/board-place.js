/**
 * server/lib/board-place.js —— 统一落位引擎（2026-08-25 范式重做第一刀）
 *
 * 之前落位算法散落六套（findSpot / write-on-board 的 avoid / arrange 的 nudgeDown /
 * pinToZone 网格 / edit-sketch 的 placeRel（无避让）/ 前端 board-seating），
 * 方向词汇、间距、避让判据（AABB vs 中心距）各不相同，「只会往下推、推到视口外」
 * 是 08-24/08-25 信箱里最高频的一族摩擦。这里收成一份，所有服务端写方共用。
 *
 * 契约（跟站主拍板的三条一致）：
 *   1. **落位没有失败分支**。「放不下」永远退化成「放别处并说清楚」——返回里带
 *      resolution 与 rejected 标记，绝不抛错、绝不返回 null。
 *   2. 优先级：reply_to > at > near+side > 视口空地 > 内容底下。
 *      at 与 near 同给时 at 定位置、near 只管画线（画线是调用方的事）。
 *   3. 撞了做 24px 网格环形搜索按距离排序，有 side 时优先同侧半平面；
 *      远场（内容包围盒外扩一屏之外）的 at 被拒后落回锚点/视口路径，标 rejected-farfield。
 *
 * 返回：{ x, y, resolution, rejected?, nudged }
 *   resolution ∈ reply-to | at | near-right|near-left|near-above|near-below | viewport | bottom | fallback
 *   nudged = 实际点偏离理想点（true 时调用方的返回文案该报「挪了位置」）
 *
 * 纯函数，不碰磁盘。障碍集由调用方给（尺寸走 estimateSizeOn，主角放大要算进去）。
 */

export const UNIT = 24;          // 网格步长，与 sketch-layout 同一常数
const PAD = 12;                  // 落位时物件四周留白（碰撞判定带上它）
const MAX_RING = 20;             // 环形搜索半径（格）：站主定的 20 格，之外走兜底
const ONE_SCREEN = { w: 1750, h: 1125 };   // 远场判据的「一屏」缺省（0.8 倍 1400×900）

const overlaps = (a, b, pad = 0) => !(
  a.x + a.w + pad <= b.x || b.x + b.w <= a.x - pad
  || a.y + a.h + pad <= b.y || b.y + b.h <= a.y - pad
);

function collides(x, y, w, h, obstacles) {
  const r = { x, y, w, h };
  for (const o of obstacles) if (overlaps(r, o, PAD)) return true;
  return false;
}

/** 一组矩形的包围盒（空集返回 null） */
function bbox(rects) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * 环形搜索：从理想点出发，按 24px 网格一圈圈向外找第一个不撞的位置。
 * 同一圈内按到理想点的欧氏距离排序；sidePref 给了就先试同侧半平面的候选
 * （相对 anchor 矩形），同圈同侧的赢过同圈异侧的。
 */
function ringSearch(ideal, box, obstacles, { sidePref = null, anchor = null, maxRing = MAX_RING } = {}) {
  if (!collides(ideal.x, ideal.y, box.w, box.h, obstacles)) {
    return { x: ideal.x, y: ideal.y, nudged: false };
  }
  const inHalfPlane = (x, y) => {
    if (!sidePref || !anchor) return true;
    if (sidePref === 'right') return x >= anchor.x + anchor.w;
    if (sidePref === 'left') return x + box.w <= anchor.x;
    if (sidePref === 'below') return y >= anchor.y + anchor.h;
    return y + box.h <= anchor.y;   // above
  };
  for (let r = 1; r <= maxRing; r += 1) {
    const cands = [];
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只走这一圈
        const x = ideal.x + dx * UNIT; const y = ideal.y + dy * UNIT;
        cands.push({ x, y, d: dx * dx + dy * dy, side: inHalfPlane(x, y) ? 0 : 1 });
      }
    }
    cands.sort((a, b) => a.side - b.side || a.d - b.d);
    for (const c of cands) {
      if (c.side === 1 && sidePref) continue;   // 本圈先只试同侧；异侧留给"整体没侧"时
      if (!collides(c.x, c.y, box.w, box.h, obstacles)) return { x: c.x, y: c.y, nudged: true };
    }
    // 同侧全撞：这一圈放开半平面再试一遍（宁可换侧，不要推远）
    for (const c of cands) {
      if (c.side === 0) continue;
      if (!collides(c.x, c.y, box.w, box.h, obstacles)) return { x: c.x, y: c.y, nudged: true };
    }
  }
  return null;
}

/** 视口扫描（保留 08-23 的阅读顺序纪律：先挑不在已有内容左侧/上方的位置） */
function viewportScan(box, obstacles, viewport) {
  if (!viewport || viewport.w < box.w + 24 || viewport.h < box.h + 24) return null;
  const content = obstacles.length ? {
    x: Math.min(...obstacles.map(o => o.x)), y: Math.min(...obstacles.map(o => o.y)),
  } : null;
  const sx = Math.max(24, Math.round(viewport.w / 8));
  const sy = Math.max(24, Math.round(viewport.h / 8));
  for (const strict of [true, false]) {
    for (let y = viewport.y + 12; y + box.h <= viewport.y + viewport.h - 12; y += sy) {
      for (let x = viewport.x + 12; x + box.w <= viewport.x + viewport.w - 12; x += sx) {
        if (strict && content && (x < content.x - 24 || y < content.y - 24)) continue;
        if (!collides(x, y, box.w, box.h, obstacles)) return { x, y };
      }
    }
  }
  return null;
}

/** 内容底下的兜底起排线：左缘对齐已有内容，纵向排在最低边之下 */
function bottomSpot(box, obstacles, contentBottom) {
  const left = obstacles.length ? Math.min(...obstacles.map(o => o.x)) : 10;
  return { x: Math.round(left), y: Math.round(contentBottom) + 40 };
}

/** 落点实际在锚点的哪一侧（半平面判定；斜对角按位移大的那个轴算） */
function sideOf(pos, box, anchor) {
  const right = pos.x >= anchor.x + anchor.w;
  const left = pos.x + box.w <= anchor.x;
  const below = pos.y >= anchor.y + anchor.h;
  const above = pos.y + box.h <= anchor.y;
  const dx = right ? pos.x - (anchor.x + anchor.w) : left ? anchor.x - (pos.x + box.w) : 0;
  const dy = below ? pos.y - (anchor.y + anchor.h) : above ? anchor.y - (pos.y + box.h) : 0;
  if ((right || left) && dx >= dy) return right ? 'right' : 'left';
  if (below || above) return below ? 'below' : 'above';
  if (right || left) return right ? 'right' : 'left';
  return null;
}

/**
 * 统一落位。参数全部可选组合：
 *   box          {w,h} 必给
 *   replyTo      {x,y,w,h} 被回应那条的矩形 → 正下方同列（线程）
 *   at           {x,y} 世界坐标意向（建议值，服务端永远 snap；远场被拒）
 *   anchor       {x,y,w,h} near 目标的矩形
 *   side         'right'|'left'|'above'|'below'  锚定方向偏好（缺省 right）
 *   obstacles    [{x,y,w,h}] 同层已摆的矩形（不含 subject 自己）
 *   contentBottom 数字
 *   viewport     {x,y,w,h}|null 用户视口（世界坐标）
 *   screen       {w,h}|null 用户一屏的世界像素（远场判据用；缺省 1750×1125）
 */
export function resolvePlacement({
  box, replyTo = null, at = null, anchor = null, side = null, gap = UNIT,
  obstacles = [], contentBottom = 0, viewport = null, screen = null,
}) {
  const w = Math.max(1, Math.round(box?.w || 0));
  const h = Math.max(1, Math.round(box?.h || 0));
  const b = { w, h };
  const snap = (v) => Math.round(v / UNIT) * UNIT;
  let rejected = null;

  // 1) 线程：正下方同列。环搜也钉住同列偏好（side below）。
  if (replyTo) {
    const ideal = { x: Math.round(replyTo.x), y: Math.round(replyTo.y + replyTo.h + PAD) };
    const hit = ringSearch(ideal, b, obstacles, { sidePref: 'below', anchor: replyTo });
    if (hit) return { ...hit, resolution: 'reply-to', rejected };
    const fb = bottomSpot(b, obstacles, contentBottom);
    return { ...fb, resolution: 'fallback', rejected, nudged: true };
  }

  // 2) 世界坐标意向：远场拒（不报错，落回下一条路），近场 snap + 环搜。
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const scr = screen || ONE_SCREEN;
    const zone = bbox([...obstacles, ...(viewport ? [viewport] : [])]);
    const far = zone
      ? (at.x < zone.x - scr.w || at.x > zone.x + zone.w + scr.w
        || at.y < zone.y - scr.h || at.y > zone.y + zone.h + scr.h)
      : false;   // 空板没有远场：哪里都是近场
    if (far) {
      rejected = 'farfield';
    } else {
      const ideal = { x: snap(at.x), y: snap(at.y) };
      const hit = ringSearch(ideal, b, obstacles, {});
      if (hit) return { ...hit, resolution: 'at', rejected, nudged: hit.nudged };
      rejected = rejected || 'at-crowded';
    }
    // 被拒/没洞 → 继续走锚点/视口/兜底路径（落位没有失败分支）
  }

  // 3) 锚点：按 side 偏好出理想点，环搜就近找洞（不再单方向推远）。
  //    环搜自己会在同侧挤满时换侧（宁可换侧不推远），所以这里只发一次搜索，
  //    落点的真实侧位事后量出来进 resolution —— 文案必须报实际发生的事。
  if (anchor) {
    const pref = side || 'right';
    const g = Number.isFinite(gap) ? gap : UNIT;
    const ideals = {
      right: { x: anchor.x + anchor.w + g, y: anchor.y },
      left: { x: anchor.x - g - w, y: anchor.y },
      below: { x: anchor.x, y: anchor.y + anchor.h + g },
      above: { x: anchor.x, y: anchor.y - g - h },
    };
    const hit = ringSearch(ideals[pref], b, obstacles, { sidePref: pref, anchor });
    if (hit) {
      const actual = sideOf(hit, b, anchor) || pref;
      return { ...hit, resolution: `near-${actual}`, rejected, nudged: hit.nudged || actual !== pref };
    }
    const fb = bottomSpot(b, obstacles, contentBottom);
    return { ...fb, resolution: 'fallback', rejected, nudged: true };
  }

  // 4) 用户视口
  const vp = viewportScan(b, obstacles, viewport);
  if (vp) return { ...vp, resolution: 'viewport', rejected, nudged: false };

  // 5) 内容底下
  const fb = bottomSpot(b, obstacles, contentBottom);
  return { ...fb, resolution: 'bottom', rejected, nudged: false };
}

/**
 * 精灵身位（2026-08-27，清「findSpot 看不见精灵」的挂账）。
 *
 * 角色精灵在**客户端**贴着该角色最新一条板书摆（RoleSprites 的 findWorkSpot），
 * 服务端永远不知道精灵的真实坐标（它跟着用户的相机走）。能知道的是：精灵一定
 * 贴在「这个 rp- 作者最新写的那条」旁边。所以服务端落位时把每个角色的最新一条
 * 板书当成一块**带身位的**障碍 —— 四周多让 pad，新东西就不会压在精灵脸上。
 *
 * 「最新」按 objects 的插入序（落盘就是写入序），不读时间字段 —— 不是每种
 * 条目都有可比的时间戳。近似而非精确，代价只是那一圈多留 60px 空。
 *
 * @param {Array<{id,x,y,w,h}>} obstacles  已建好的障碍表（含 id）
 * @param {object} objects   board.objects 原始表（要 by 字段）
 */
export function inflateSpriteSeats(obstacles, objects, pad = 60) {
  const last = new Map();   // rp-author → 它最新一条的 id
  for (const [id, e] of Object.entries(objects || {})) {
    if (typeof e?.by === 'string' && e.by.startsWith('rp-')) last.set(e.by, id);
  }
  if (!last.size) return obstacles;
  const ids = new Set(last.values());
  return obstacles.map((o) => (ids.has(o.id)
    ? { ...o, x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 }
    : o));
}

/**
 * 调用方的返回文案助手：把 resolution 翻译成一句人话（工具返回必须报
 * 请求/实际/resolution —— 08-25 三个静默陷阱之③「工具返回在撒谎」的解法
 * 就是让文案从真实 resolution 生成，不再手拼）。
 */
export function describePlacement(r, { requestedAt = null } = {}) {
  const parts = [];
  if (r.resolution === 'reply-to') parts.push('under the note it replies to (thread)');
  else if (r.resolution === 'at') parts.push(r.nudged ? 'near the requested spot (snapped/nudged to a free cell)' : 'at the requested spot (snapped to grid)');
  else if (r.resolution.startsWith('near-')) parts.push(`${r.resolution.slice(5)} of the anchor${r.nudged ? ' (nudged to the nearest free cell)' : ''}`);
  else if (r.resolution === 'viewport') parts.push("in the user's viewport");
  else if (r.resolution === 'bottom') parts.push('below current content');
  else parts.push('below current content (no free cell near the target)');
  if (r.rejected === 'farfield') parts.push(`requested at (${Math.round(requestedAt?.x ?? 0)},${Math.round(requestedAt?.y ?? 0)}) was outside the working area (one screen beyond content) — placed nearer instead`);
  else if (r.rejected === 'at-crowded') parts.push('requested spot was crowded');
  return parts.join('; ');
}
