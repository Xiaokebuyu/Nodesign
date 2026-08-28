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

import { UNIT, overlaps, bboxOf, segHitsRect, pointIn } from './rect.js';
import { ROLE_SLUG_RE } from '../engine/agent/cast.js';

export { UNIT };                 // 兼容出口：一批调用方从这里拿（真身在 rect.js）
const PAD = 12;                  // 落位时物件四周留白（碰撞判定带上它）
const MAX_RING = 20;             // 环形搜索半径（格）：站主定的 20 格，之外走兜底
// 远场判据的「一屏」缺省（1400×900 屏 ÷ 0.8 倍缩放）。⚠️ 跟 sketch-layout.js 的
// SKETCH_FIT（1700×1100，可读性上限）是同一个「0.8 倍一屏」基准的两个近邻值 ——
// 语义不同（远场容忍 vs 推荐尺寸）所以不共享常量，但改缩放基准要两处一起看。
const ONE_SCREEN = { w: 1750, h: 1125 };

function collides(x, y, w, h, obstacles) {
  const r = { x, y, w, h };
  for (const o of obstacles) if (overlaps(r, o, PAD)) return true;
  return false;
}

/**
 * 环形搜索：从理想点出发，按 24px 网格一圈圈向外找第一个不撞的位置。
 * 同一圈内按到理想点的欧氏距离排序；sidePref 给了就先试同侧半平面的候选
 * （相对 anchor 矩形），同圈同侧的赢过同圈异侧的。
 *
 * lineFrom（2026-08-27 观感措施）：新块几乎总会跟锚点连一条线，线横穿第三块
 * 是版面最难看的一种。给了 lineFrom 就偏好「lineFrom → 候选中心」不压别的块
 * 的位置 —— best-effort：先收下最近的可用位当保底，再多看最多 3 圈找线干净的；
 * 找不到还是要保底那个（距离仍是第一语言，线是第二语言）。
 * 理想点本身空着时不查线：贴身位的连线穿不过第三块（间隙里塞不下能撞 PAD 的东西）。
 */
function ringSearch(ideal, box, obstacles, { sidePref = null, anchor = null, maxRing = MAX_RING, lineFrom = null } = {}) {
  if (!collides(ideal.x, ideal.y, box.w, box.h, obstacles)) {
    return { x: ideal.x, y: ideal.y, nudged: false };
  }
  // lineFrom 收单点或点数组（08-27 落位直觉：一条新板书可能同时连着锚点和
  // 线程前一条 —— 哪条线都不该压在第三块身上）
  const linesFrom = lineFrom ? (Array.isArray(lineFrom) ? lineFrom : [lineFrom]) : [];
  const inHalfPlane = (x, y) => {
    if (!sidePref || !anchor) return true;
    if (sidePref === 'right') return x >= anchor.x + anchor.w;
    if (sidePref === 'left') return x + box.w <= anchor.x;
    if (sidePref === 'below') return y >= anchor.y + anchor.h;
    return y + box.h <= anchor.y;   // above
  };
  const lineClear = (x, y) => {
    if (!linesFrom.length) return true;
    const c = { x: x + box.w / 2, y: y + box.h / 2 };
    for (const o of obstacles) {
      // 锚点自己（以及跟它重叠的身位膨胀）不算「第三块」—— 线本来就从它出发
      if (anchor && overlaps(o, anchor)) continue;
      for (const p of linesFrom) {
        if (pointIn(p, o)) continue;   // 这条线的出发块自己，也不算第三块
        if (segHitsRect(p, c, o)) return false;
      }
    }
    return true;
  };
  let fallback = null;   // 最近的可用但线被压的位置（含它在第几圈）
  for (let r = 1; r <= maxRing; r += 1) {
    if (fallback && r > fallback.ring + 3) break;   // 保底之外只多看 3 圈
    const cands = [];
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只走这一圈
        const x = ideal.x + dx * UNIT; const y = ideal.y + dy * UNIT;
        cands.push({ x, y, d: dx * dx + dy * dy, side: inHalfPlane(x, y) ? 0 : 1 });
      }
    }
    cands.sort((a, b) => a.side - b.side || a.d - b.d);
    // 两趟：先只试同侧，同侧全撞再放开半平面（宁可换侧，不要推远 —— 原语义）。
    // ⚠️ 侧位赢过连线：同侧只要有可用位（哪怕压线，已记进保底），就不再看异侧
    // —— 否则「正下方接楼」会为了一条干净线飘到楼上去（reply-to 测试抓过）。
    for (const pass of [0, 1]) {
      if (pass === 1 && fallback) break;
      for (const c of cands) {
        if (c.side !== pass) continue;
        if (collides(c.x, c.y, box.w, box.h, obstacles)) continue;
        if (lineClear(c.x, c.y)) return { x: c.x, y: c.y, nudged: true };
        if (!fallback) fallback = { x: c.x, y: c.y, ring: r };
      }
    }
  }
  return fallback ? { x: fallback.x, y: fallback.y, nudged: true } : null;
}

/**
 * 落位直觉之一：side 没显式给时**自动挑一侧**（2026-08-27 用户提「落位直觉」）。
 *
 * 之前缺省恒 right —— 右边被占就从右侧理想点环搜，结果可能贴着占位块乱钻，
 * 明明上方一片空。现在按阅读序试四侧（用户摆放偏好在前），第一个「理想位不撞
 * 且连线不压第三块」的侧赢；全都压线就取第一个不撞的；连不撞的都没有回缺省，
 * 让环搜兜底 —— 挑侧只是挑起点，落位仍然没有失败分支。
 */
function pickSide({ anchor, box, gap, obstacles, prefer = null, linesFrom = [] }) {
  const order = [...new Set([prefer, 'right', 'below', 'above', 'left'].filter(Boolean))];
  const idealOf = (s) => ({
    right: { x: anchor.x + anchor.w + gap, y: anchor.y },
    left: { x: anchor.x - gap - box.w, y: anchor.y },
    below: { x: anchor.x, y: anchor.y + anchor.h + gap },
    above: { x: anchor.x, y: anchor.y - gap - box.h },
  })[s];
  const clear = (i) => {
    const c = { x: i.x + box.w / 2, y: i.y + box.h / 2 };
    for (const o of obstacles) {
      if (overlaps(o, anchor)) continue;
      for (const p of linesFrom) {
        if (pointIn(p, o)) continue;
        if (segHitsRect(p, c, o)) return false;
      }
    }
    return true;
  };
  let firstFree = null;
  for (const s of order) {
    const i = idealOf(s);
    if (collides(i.x, i.y, box.w, box.h, obstacles)) continue;
    if (clear(i)) return s;
    if (!firstFree) firstFree = s;
  }
  return firstFree || prefer || 'right';
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
  // 落位直觉（08-27）：replyDir = 线程接楼方向（从用户摆放学来，缺省 below）；
  // sideHint = side 自动挑时排最前的偏好；lineTargets = 除锚点外还会连线的点
  replyDir = null, sideHint = null, lineTargets = [],
}) {
  const w = Math.max(1, Math.round(box?.w || 0));
  const h = Math.max(1, Math.round(box?.h || 0));
  const b = { w, h };
  const snap = (v) => Math.round(v / UNIT) * UNIT;
  let rejected = null;

  // 1) 线程：缺省正下方同列；replyDir 学到用户把这条线横着摆时改成同排横接
  //    （above 不认 —— 线程倒着往上长没有读序可言）。
  if (replyTo) {
    const dir = (replyDir === 'right' || replyDir === 'left') ? replyDir : 'below';
    const ideal = dir === 'below'
      ? { x: Math.round(replyTo.x), y: Math.round(replyTo.y + replyTo.h + PAD) }
      : dir === 'right'
        ? { x: Math.round(replyTo.x + replyTo.w + PAD), y: Math.round(replyTo.y) }
        : { x: Math.round(replyTo.x - PAD - w), y: Math.round(replyTo.y) };
    const hit = ringSearch(ideal, b, obstacles, {
      sidePref: dir, anchor: replyTo,
      lineFrom: [{ x: replyTo.x + replyTo.w / 2, y: replyTo.y + replyTo.h / 2 }, ...lineTargets],
    });
    if (hit) return { ...hit, resolution: 'reply-to', rejected };
    const fb = bottomSpot(b, obstacles, contentBottom);
    return { ...fb, resolution: 'fallback', rejected, nudged: true };
  }

  // 2) 世界坐标意向：远场拒（不报错，落回下一条路），近场 snap + 环搜。
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const scr = screen || ONE_SCREEN;
    const zone = bboxOf([...obstacles, ...(viewport ? [viewport] : [])]);
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
  //    side 没显式给就自动挑（pickSide：哪侧空、连线不压块、用户偏好排前）。
  //    环搜自己会在同侧挤满时换侧（宁可换侧不推远），所以这里只发一次搜索，
  //    落点的真实侧位事后量出来进 resolution —— 文案必须报实际发生的事。
  if (anchor) {
    const g = Number.isFinite(gap) ? gap : UNIT;
    // 连线走廊：near 落位几乎总配一条到锚点的线（write_on_board 的 near-line /
    // relation），挑侧和环搜都尽量选「线不压第三块」的位置
    const linesFrom = [{ x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 }, ...lineTargets];
    const pref = side
      || pickSide({ anchor, box: b, gap: g, obstacles, prefer: sideHint, linesFrom });
    const ideals = {
      right: { x: anchor.x + anchor.w + g, y: anchor.y },
      left: { x: anchor.x - g - w, y: anchor.y },
      below: { x: anchor.x, y: anchor.y + anchor.h + g },
      above: { x: anchor.x, y: anchor.y - g - h },
    };
    const hit = ringSearch(ideals[pref], b, obstacles, { sidePref: pref, anchor, lineFrom: linesFrom });
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
/**
 * 挑锚点旁的空侧（08-28 台词侧挂）：右侧贴身位空着就右，不然左侧空就左，
 * 两边都挤仍回右（ringSearch 会就近挪）。判据跟真实落位同一套碰撞（PAD 含内）。
 */
export function pickFreeSide(anchor, box, obstacles) {
  const w = Math.max(1, Math.round(box?.w || 0));
  const h = Math.max(1, Math.round(box?.h || 0));
  if (!collides(anchor.x + anchor.w + PAD, anchor.y, w, h, obstacles)) return 'right';
  if (!collides(anchor.x - PAD - w, anchor.y, w, h, obstacles)) return 'left';
  return 'right';
}

export function inflateSpriteSeats(obstacles, objects, pad = 60) {
  const last = new Map();   // rp-author → 它最新一条的 id
  for (const [id, e] of Object.entries(objects || {})) {
    if (typeof e?.by === 'string' && ROLE_SLUG_RE.test(e.by)) last.set(e.by, id);
  }
  if (!last.size) return obstacles;
  const ids = new Set(last.values());
  return obstacles.map((o) => (ids.has(o.id)
    ? { ...o, x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 }
    : o));
}

/**
 * 落位直觉之二：从用户亲手摆放里学版面方向（2026-08-27 用户提）。
 *
 * 场景：chain 的机器缺省是「正下方接楼」，但用户一直把线程里的板书往右拖 ——
 * 竖楼被他掰成横排（seat:'user' 一路向右，proj_mtbkhpac 实案）。机器该跟着他，
 * 不是每次都竖着落、等他再拖一次。
 *
 * 判据只认**用户亲手放的**（下游 seat:'user'）—— agent 自己的落位不算票，
 * 否则机器的缺省会自我强化成"学到了自己"。方向取 flow 线两端中心的主轴；
 * 太近的（<60px，基本重叠）不算方向。近期 limit 票里某方向 ≥2 票且占 2/3
 * 才算学到，否则 null（拿不准就不押 —— 缺省行为不变是底线）。
 *
 * tag 给了只看这条线自己的票（**一条线一个走向**）：用户把调研线掰横，不该让
 * 新开的章节线也跟着横 —— 新线从缺省开始，用户掰了这条再学这条。
 * 全板口径（tag 不传）只给无线程归属的散落位用。
 *
 * @param {object} board  readBoard 的整份（要 objects + bindings）
 * @returns {'right'|'left'|'below'|'above'|null}
 */
export function inferFlowDir(board, { tag = null, limit = 6 } = {}) {
  const objs = board?.objects || {};
  const votes = [];
  for (const e of Object.values(board?.bindings || {})) {
    if (e?.type !== 'flow') continue;
    if (tag && e.tag !== tag) continue;
    const from = objs[e.from]; const to = objs[e.to];
    if (!from || !to || to.seat !== 'user') continue;
    const dx = (to.x + (to.w || 0) / 2) - (from.x + (from.w || 0) / 2);
    const dy = (to.y + (to.h || 0) / 2) - (from.y + (from.h || 0) / 2);
    if (Math.abs(dx) < 60 && Math.abs(dy) < 60) continue;
    votes.push(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'below' : 'above'));
  }
  const recent = votes.slice(-limit);
  if (recent.length < 2) return null;
  const count = {};
  for (const v of recent) count[v] = (count[v] || 0) + 1;
  const [best, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return (n >= 2 && n * 3 >= recent.length * 2) ? best : null;
}

/**
 * 调用方的返回文案助手：把 resolution 翻译成一句人话（工具返回必须报
 * 请求/实际/resolution —— 08-25 三个静默陷阱之③「工具返回在撒谎」的解法
 * 就是让文案从真实 resolution 生成，不再手拼）。
 */
export function describePlacement(r, { requestedAt = null } = {}) {
  const parts = [];
  if (r.resolution === 'reply-to') parts.push('under the note it replies to (thread)');
  else if (r.resolution === 'lane-open') parts.push('at the head of a new lane column');
  else if (r.resolution === 'at') parts.push(r.nudged ? 'near the requested spot (snapped/nudged to a free cell)' : 'at the requested spot (snapped to grid)');
  else if (r.resolution.startsWith('near-')) parts.push(`${r.resolution.slice(5)} of the anchor${r.nudged ? ' (nudged to the nearest free cell)' : ''}`);
  else if (r.resolution === 'viewport') parts.push("in the user's viewport");
  else if (r.resolution === 'bottom') parts.push('below current content');
  else parts.push('below current content (no free cell near the target)');
  if (r.rejected === 'farfield') parts.push(`requested at (${Math.round(requestedAt?.x ?? 0)},${Math.round(requestedAt?.y ?? 0)}) was outside the working area (one screen beyond content) — placed nearer instead`);
  else if (r.rejected === 'at-crowded') parts.push('requested spot was crowded');
  return parts.join('; ');
}
