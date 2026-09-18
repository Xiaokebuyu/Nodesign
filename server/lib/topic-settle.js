/**
 * server/lib/topic-settle.js —— 话题的地盘与整组让开（2026-09-18）
 *
 * 规则与站主的四条拍板写在前端那份 web/src/lib/topic-settle.js 头上。END-MIRROR 之间是逐字镜像
 * （topic-settle.test.js 比对）；镜像之外是服务端才有的两件：从板上取这一层的矩形、把让开落盘。
 *
 * 调用方：agent 写板书（write_on_board）、改字（edit_board set_text / set_vars）、挪（move / move_group）、
 * 钉东西（pin_to_board）之后各调一次 settleBoard。前端量出真高之后在本地调纯函数那份。
 */
import { readBoard, patchBoard } from '../projects/board-store.js';
import { obstaclesIn } from './board-obstacles.js';

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

/**
 * 这一层参与让开的矩形：障碍集（已剔掉叠在身后的旧版、磁盘上没有的座位）带上 tag / hug，
 * 再给用户的蓝字标注记上它标的是谁（note），它跟着那件走。
 */
export function settleItems(board, zone = '', { objects = null, sharedRoot = null } = {}) {
  const objs = objects || board?.objects || {};
  const note = new Map();
  for (const b of Object.values(board?.bindings || {})) {
    if (b?.type === 'annotates' && b.by === 'user' && String(b.from).startsWith('text:')) note.set(b.from, b.to);
  }
  const rolled = new Set(Object.keys(board?.rolls || {}));
  return obstaclesIn({ ...board, objects: objs }, zone, { objects: objs, sharedRoot }).map((r) => {
    const e = objs[r.id] || {};
    return {
      ...r,
      ...(e.tag ? { tag: e.tag } : {}), ...(e.hug ? { hug: e.hug } : {}),
      ...(note.has(r.id) ? { note: note.get(r.id) } : {}),
      ...(e.tag && rolled.has(e.tag) ? { fixed: true } : {}),   // 收着的组只剩一张卷卡，不推
    };
  });
}

/**
 * 让开并落盘。changedIds 里的东西在这一刻的尺寸 / 位置已经写进板了（调用方先落自己的改动）。
 * @param {string} pid
 * @param {string[]} changedIds
 * @param {object} [opts]  { zone, grewFrom: {id: 旧高}, sharedRoot }
 * @returns {Promise<{moves, pushed, blocked}>}
 */
export async function settleBoard(pid, changedIds, { zone = '', grewFrom = null, sharedRoot = null } = {}) {
  if (!changedIds?.length) return { moves: [], pushed: [], blocked: [] };
  const board = await readBoard(pid);
  const out = settleTopics(settleItems(board, zone, { sharedRoot }), changedIds, { grewFrom });
  if (out.moves.length) {
    await patchBoard(pid, { objects: Object.fromEntries(out.moves.map((m) => [m.id, { x: Math.round(m.x), y: Math.round(m.y) }])) });
  }
  return out;
}

/** 让开的报文（给 agent 的一句话） */
export function describeSettle(out) {
  if (!out?.pushed?.length && !out?.blocked?.length) return '';
  const name = (k) => (k.startsWith('#') ? k : k.slice(1));
  const parts = [];
  if (out.pushed.length) parts.push(`为了给它腾地方，${out.pushed.slice(0, 4).map(name).join('、')}${out.pushed.length > 4 ? ` 等 ${out.pushed.length} 组` : ''} 整组让开了`);
  if (out.blocked.length) parts.push(`压到了推不动的 ${out.blocked.slice(0, 3).map(name).join('、')}`);
  return `（${parts.join('；')}）`;
}
