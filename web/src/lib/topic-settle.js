/**
 * topic-settle.js —— 话题的地盘与整组让开（2026-09-18，站主定）
 *
 * ## 站主的原话与四条拍板
 *
 * 「折叠有点难看……活用 tag，给 tag 一个排斥体积，以 tag 为单位区分话题，这样折叠似乎也不是那么必要」。
 *   1. 不限横竖：撞到别人就整体避让（「这不就是无限画布存在的意义之一吗」）
 *   2. 没 tag 的产物不硬归话题，只提醒 agent 带上 tag
 *   3. 折叠整个去掉：板书按真高显示
 *   4. 地盘画出来：就是 TagHullLayer 那道虚线包络（它和这里用同一个外扩值 TOPIC_PAD）
 *
 * ## 规则
 *
 * - 话题 = 同 tag 的一组；没 tag 的一件自成一个话题。圈注涂鸦（hug）和用户的蓝字标注归它圈 / 标的那件的话题
 *   （不然被标注的卡一长高，先把标注推开）。
 * - 地盘 = 成员外框外扩 TOPIC_PAD。两个话题的地盘不许相交。
 * - 某个话题长大了（卡变高变宽、加了新成员、被机器挪过），撞上的话题**整组**朝位移最小的方向让开；
 *   让开的再撞到别人接着传，最多 MAX_HOPS 层、累计位移不超过 MAX_TOTAL。长大的那个话题自己不动。
 * - 不动的：浮层（卷卡 roll: / 生图幻影 ph: / 直播框 live:）、文件夹卡、调用方标成 fixed 的。撞上它们只报不推。
 * - 同一话题里，长高的那件下面压着的同组件先顺着往下推（跟 09-11 的改字变高同一条算法）。
 *
 * 纯函数：吃矩形，吐位移。前端（量出真高之后）和服务端（agent 写入、改字、钉东西之后）各调一份。
 * ⚠️ 服务端 server/lib/topic-settle.js 是 END-MIRROR 之间的逐字镜像，topic-settle.test.js 逐字比对。
 */

// ── 以下到 END-MIRROR 前后端逐字一致 ──
/**
 * 地盘外扩（= TagHullLayer 画的那道包络的外扩）。取 12：两块地盘刚好在机器落位的标准间距（UNIT 24）处相切，
 * 跟随 / 贴放把两个话题并排摆时不会一落下就被判相撞再推开半格（原来包络是 18，09-18 真跑逮到）。
 */
export const TOPIC_PAD = 12;
/** 同组往下推时留的间距（= board-reflow 的 STACK_GAP） */
export const WITHIN_GAP = 16;
const MAX_HOPS = 4;
const MAX_TOTAL = 2400;
const FIXED_ID = /^(roll:|ph:|live:)/;

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 每一件归哪个话题。
 * @param {Array<{id,tag?,hug?,note?}>} items  note = 用户蓝字标注连着的目标 id
 * @returns {Map<string,string>} id → 话题键（`#tag` 或 `@id`）
 */
export function topicKeys(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const own = (it) => (it?.tag ? `#${it.tag}` : `@${it?.id}`);
  const keys = new Map();
  for (const it of items) {
    const host = !it.tag && (it.hug || it.note) ? byId.get(it.hug || it.note) : null;
    keys.set(it.id, host ? own(host) : own(it));
  }
  return keys;
}

/** 一组矩形的地盘（外框外扩 TOPIC_PAD） */
export function regionOf(rects, pad = TOPIC_PAD) {
  const x0 = Math.min(...rects.map((r) => r.x)); const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)); const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** 话题表：键 → { key, members, fixed } */
export function topicsOf(items) {
  const keys = topicKeys(items);
  const out = new Map();
  for (const it of items) {
    const k = keys.get(it.id);
    if (!out.has(k)) out.set(k, { key: k, members: [], fixed: false });
    const t = out.get(k);
    t.members.push(it);
    if (it.fixed || it.folder || FIXED_ID.test(String(it.id))) t.fixed = true;
  }
  return out;
}

/** 把 b 挪出 a 的最小位移（四个方向里取最短） */
function clearOf(a, b) {
  const dirs = [
    { dx: a.x + a.w - b.x, dy: 0 },
    { dx: a.x - (b.x + b.w), dy: 0 },
    { dx: 0, dy: a.y + a.h - b.y },
    { dx: 0, dy: a.y - (b.y + b.h) },
  ];
  dirs.sort((p, q) => (Math.abs(p.dx) + Math.abs(p.dy)) - (Math.abs(q.dx) + Math.abs(q.dy)));
  return dirs[0];
}

/**
 * 同一话题里，长高的那件下面压着的同组件顺着往下推（被推的几件彼此间距不变；变矮不往上收）。
 * @returns {Array<{id,dy}>}
 */
export function pushDownWithin(grown, oldH, others, gap = WITHIN_GAP) {
  if (!(grown.h > oldH)) return [];
  const below = others.filter((r) => r.y >= grown.y + oldH - 1 && r.x < grown.x + grown.w && grown.x < r.x + r.w);
  if (!below.length) return [];
  const dy = Math.round(grown.y + grown.h + gap - Math.min(...below.map((r) => r.y)));
  return dy > 0 ? below.map((r) => ({ id: r.id, dy })) : [];
}

/**
 * 让开。
 * @param {Array<{id,x,y,w,h,tag?,hug?,note?,fixed?,folder?}>} items  这一层的全部矩形（已是变化之后的尺寸与位置）
 * @param {string[]} changedIds  长大 / 新来 / 被挪过的那几件
 * @param {object} [opts]
 * @param {Object<string,number>} [opts.grewFrom]  id → 长高之前的高（给了就先做同组往下推）
 * @returns {{ moves: Array<{id,dx,dy,x,y}>, pushed: string[], blocked: string[] }}
 *   pushed = 整组让开了的话题键；blocked = 撞上了但推不动的（浮层 / 文件夹卡 / 连锁到顶）
 */
export function settleTopics(items, changedIds, { grewFrom = null } = {}) {
  const live = items.map((it) => ({ ...it }));
  const byId = new Map(live.map((it) => [it.id, it]));
  const topics = topicsOf(live);
  const keyOf = topicKeys(live);
  const moved = new Map();
  const shift = (it, dx, dy) => {
    it.x += dx; it.y += dy;
    const acc = moved.get(it.id) || { dx: 0, dy: 0 };
    moved.set(it.id, { dx: acc.dx + dx, dy: acc.dy + dy });
  };
  // ① 同组往下推
  for (const [id, oldH] of Object.entries(grewFrom || {})) {
    const g = byId.get(id);
    if (!g) continue;
    const t = topics.get(keyOf.get(id));
    const others = t.members.filter((m) => m !== g && !m.hug && !m.note);
    for (const p of pushDownWithin(g, oldH, others)) shift(byId.get(p.id), 0, p.dy);
  }
  // ② 话题之间整组让开
  const origin = new Set(changedIds.map((id) => keyOf.get(id)).filter(Boolean));
  const pushed = new Set(); const blocked = new Set();
  let front = [...origin]; let total = 0;
  for (let hop = 0; hop < MAX_HOPS && front.length; hop += 1) {
    const next = [];
    for (const k of front) {
      const r = regionOf(topics.get(k).members);
      for (const u of topics.values()) {
        if (u.key === k || origin.has(u.key)) continue;
        const ru = regionOf(u.members);
        if (!overlap(r, ru)) continue;
        if (u.fixed) { blocked.add(u.key); continue; }
        const d = clearOf(r, ru);
        total += Math.abs(d.dx) + Math.abs(d.dy);
        if (total > MAX_TOTAL) { blocked.add(u.key); continue; }
        for (const m of u.members) shift(m, d.dx, d.dy);
        pushed.add(u.key);
        next.push(u.key);
      }
    }
    front = next;
  }
  const moves = [...moved].filter(([, m]) => m.dx || m.dy)
    .map(([id, m]) => ({ id, dx: m.dx, dy: m.dy, x: byId.get(id).x, y: byId.get(id).y }));
  return { moves, pushed: [...pushed], blocked: [...blocked] };
}

/** 落位用的障碍：别的话题（两件以上）整块地盘当一个障碍，自己话题的成员照旧逐件 */
export function topicObstacles(rects, ownTag = null) {
  const keys = topicKeys(rects);
  const own = ownTag ? `#${ownTag}` : null;
  const groups = new Map();
  const out = [];
  for (const r of rects) {
    const k = keys.get(r.id);
    if (k === own || !k.startsWith('#')) { out.push(r); continue; }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, rs] of groups) {
    if (rs.length < 2) { out.push(...rs); continue; }
    out.push({ id: `topic:${k.slice(1)}`, ...regionOf(rs), topic: k.slice(1) });
  }
  return out;
}
// ── END-MIRROR ──
