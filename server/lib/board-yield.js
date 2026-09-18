/**
 * server/lib/board-yield.js —— 让路（2026-09-17，站主定「agent 主动摆放拥有最高路权」）
 *
 * ## 翻过来的是哪一条
 *
 * 09-05 的求解器是「**永不压任何东西**，要的位置放不下就换最近的空位」。代价是 agent
 * 说的位置经常不是它拿到的位置：真会话里「no room right, so it went below」这类报文一直在出。
 * 站主 09-17 定：路权归 agent —— 它说放哪就放哪，挡在那里的东西主动让开。
 *
 * ## 规矩（逐条都是站主拍的或当场定的）
 *
 * 1. 让的方向取**位移最小**的那一个（上下左右四选一），让到不重叠再加一个间距。
 * 2. 同一组（同 tag）**整组一起让**，不拆散。
 * 3. 连锁最多 **3 层**；累计位移超过**一屏**就整件放弃，退回原来的「找最近空位」。
 * 4. ⭐ **用户亲手摆过的东西也让**（站主：「用户很多时候只是无心之举，先不给特权，用一段时间看看」）。
 *    这条推翻了立了很久的「不与用户争夺位置」，属于试行，验收要专门看用户把东西拖回去的次数。
 * 5. 浮层类（卷卡 `roll:`、生图幻影 `ph:`、直播板书框 `live:`）不让：它们不占世界坐标，
 *    或者根本不是能落盘的座位。
 * 6. 让开要如实报给 agent（「为了放下 X，挪开了 A 和 B」），用户那边也该看得见。
 *
 * 纯函数：吃矩形，吐位移。不读盘不落盘，落盘由调用方做。
 */
import { UNIT, overlaps } from './rect.js';
import { placeBeside } from './board-place.js';

/** 不参与让路的 id 前缀：浮层与临时占位 */
const NEVER_MOVE = /^(roll:|ph:|live:|topic:)/;   // topic: = 别的话题整块地盘当的障碍（topic-settle.js），不是一件东西
/** 连锁层数上限 */
const MAX_HOPS = 3;
/** 累计位移上限（一屏） */
const MAX_TOTAL = 900;

const clear = (r, target, dir, gap) => {
  if (dir === 'right') return { dx: Math.round(target.x + target.w + gap - r.x), dy: 0 };
  if (dir === 'left') return { dx: Math.round(target.x - gap - (r.x + r.w)), dy: 0 };
  if (dir === 'below') return { dx: 0, dy: Math.round(target.y + target.h + gap - r.y) };
  return { dx: 0, dy: Math.round(target.y - gap - (r.y + r.h)) };
};

/**
 * 给 `incoming` 腾地方。
 *
 * @param {{x,y,w,h}} incoming            要落下的那件东西（已经按意图算好的位置）
 * @param {Array<{id,x,y,w,h,tag?,seat?}>} obstacles  这一层占着地方的东西
 * @param {object} [opts]
 * @param {number} [opts.gap]             让开后留的间距
 * @param {Set<string>} [opts.exclude]    不算障碍的 id（主体自己、同组成员）
 * @returns {{ ok: boolean, moves: Array<{id,dx,dy,x,y}>, why?: string }}
 *   ok=false 表示让不开（调用方退回找空位）；moves 为空表示本来就没人挡
 */
export function planYield(incoming, obstacles = [], { gap = UNIT, exclude = null } = {}) {
  const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
  const live = obstacles
    .filter((o) => o && o.id && !skip.has(o.id) && !NEVER_MOVE.test(String(o.id)))
    .map((o) => ({ ...o }));
  const moved = new Map();          // id → 累计位移
  let total = 0;

  /** 同一组一起让：没有 tag 的就它自己 */
  const groupOf = (o) => (o.tag ? live.filter((x) => x.tag === o.tag) : [o]);

  let front = [incoming];
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const hit = [];
    for (const r of front) {
      for (const o of live) {
        if (r === o) continue;
        if (overlaps(r, o)) hit.push({ r, o });
      }
    }
    if (!hit.length) return { ok: true, moves: [...moved.entries()].map(([id, m]) => ({ id, ...m })) };
    const pushedNow = [];
    for (const { r, o } of hit) {
      if (!overlaps(r, o)) continue;             // 这一轮里已经被别的位移带走了
      const dirs = ['right', 'left', 'below', 'above'].map((d) => ({ d, ...clear(o, r, d, gap) }));
      dirs.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy)));
      const best = dirs[0];
      const step = Math.abs(best.dx) + Math.abs(best.dy);
      total += step;
      if (total > MAX_TOTAL) return { ok: false, moves: [], why: '连锁让路累计超过一屏' };
      for (const m of groupOf(o)) {
        m.x += best.dx; m.y += best.dy;
        const acc = moved.get(m.id) || { dx: 0, dy: 0, x: m.x, y: m.y };
        moved.set(m.id, { dx: acc.dx + best.dx, dy: acc.dy + best.dy, x: m.x, y: m.y });
        pushedNow.push(m);
      }
    }
    front = pushedNow;
  }
  // 连锁到顶还在撞：宁可退回找空位，也不要把版面推成一团
  for (const r of front) {
    for (const o of live) if (r !== o && overlaps(r, o)) return { ok: false, moves: [], why: `连锁超过 ${MAX_HOPS} 层` };
  }
  return { ok: true, moves: [...moved.entries()].map(([id, m]) => ({ id, ...m })) };
}

/** 让路的报文（给 agent 的一句话；用户那边另有动画） */
export function describeYield(moves) {
  if (!moves?.length) return '';
  const names = moves.slice(0, 4).map((m) => m.id).join('、');
  return `（为了放下它，挪开了 ${names}${moves.length > 4 ? ` 等 ${moves.length} 件` : ''}）`;
}

/**
 * 「点名了贴谁的哪一侧」就按那儿落，挡路的让开。让不开返回 null，调用方退回求解器找空位。
 *
 * @param {object} p
 * @param {{x,y,w,h}} p.anchor
 * @param {{w,h}} p.box
 * @param {string|null} p.side           必须是 agent 明说的那一侧；没说就不该抢路权
 * @param {Array} p.obstacles
 * @param {Set<string>} [p.exclude]
 * @param {(id: string, patch: {x:number,y:number}) => void} [p.apply]  让开的位置怎么落盘
 */
export function placeByIntent({ anchor, box, side, obstacles = [], exclude = null, gap = UNIT, apply = null }) {
  if (!anchor || !side) return null;
  const want = { ...placeBeside(anchor, box, side, gap), w: box.w, h: box.h };
  const y = planYield(want, obstacles, { gap, exclude });
  if (!y.ok) return null;
  for (const m of y.moves) apply?.(m.id, { x: Math.round(m.x), y: Math.round(m.y) });
  return { x: Math.round(want.x), y: Math.round(want.y), how: 'beside', side, nudged: false, wanted: side, pressed: [], yielded: y.moves };
}
