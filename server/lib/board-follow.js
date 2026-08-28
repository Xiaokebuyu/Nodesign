/**
 * server/lib/board-follow.js —— 跟随线（2026-08-25 范式重做，第三件）
 *
 * 来历：08-25 黑板 RP 真会话里「状态板每章重新锚定到最新章节」是用户自己提出的
 * 需求，agent 每章手工 move_group + remove/add 线两次、做了十几遍。这里把它做成
 * 板上第一条**约束**：一条带 `follow: <目标tag>` 的线，to 端永远指向该 tag 最新
 * 落板的那件 —— 新件一落，服务端自动重指线、并把 from 端所在的组挪到它旁边。
 *
 * 设计取舍：
 * - 约束的家安在**线上**（不另立 rules 区）：线本来就是「A 关于 B」的真相，
 *   follow 只是把 B 从一件东西升级成「一族东西的最新一件」。
 * - 挪组时跳过 seat:'user' 的成员（用户拖过的座永远不覆盖，与 reflow 同一条纪律）。
 * - fail-soft：跟随失败绝不连累落板本身。
 */

import { readBoard, patchBoard } from '../projects/board-store.js';
import { estimateSizeOn } from './board-kind-sizes.js';
import { layerOf } from './canvas-id.js';
import { resolvePlacement } from './board-place.js';

/**
 * 某 tag 有新件落板：把所有 follow 这个 tag 的线重指到 newId，并挪各自的组。
 * @returns {Promise<{followed: number}>}
 */
export async function applyFollows(projectId, { tag, newId }) {
  if (!tag || !newId) return { followed: 0 };
  const board = await readBoard(projectId);
  const followers = Object.entries(board.bindings || {})
    .filter(([, b]) => b.follow === tag && b.to !== newId);
  if (!followers.length) return { followed: 0 };
  const target = board.objects?.[newId];
  if (!target || !Number.isFinite(target.x)) return { followed: 0 };
  // 只认主控的新件（08-28 用户拍板）：状态板这类跟随组挂在 GM 的叙事链上，
  // 角色台词/用户落痕就算落进同一个 tag 也不把面板拽走。判据按板上作者，
  // 不靠"角色自觉别打 tag"（08-27 真会话：GM 亲手让角色打 章节，面板跟着台词跑了）。
  if ((target.by || 'agent') !== 'agent') return { followed: 0 };
  const known = new Set(Object.keys(board.zones || {}));
  const targetRect = { x: target.x, y: target.y, ...estimateSizeOn(board, newId, target) };
  const targetZone = layerOf(newId, target, known);

  const objects = {}; const bindings = {};
  let followed = 0;
  for (const [bid, b] of followers) {
    // 新目标自己在跟随组里（状态板的卡也打了目标 tag 之类的配置错误）：跳过防自噬
    const fromEntry = board.objects?.[b.from];
    const groupTag = fromEntry?.tag || null;
    if (groupTag && board.objects?.[newId]?.tag === groupTag) continue;
    const oldTarget = board.objects?.[b.to];
    bindings[bid] = { ...b, to: newId };
    followed += 1;

    // 挪 from 端的组（同 tag 全员；没 tag 就只挪 from 自己）
    const members = groupTag
      ? Object.entries(board.objects).filter(([, e]) => e.tag === groupTag && Number.isFinite(e?.x))
      : (fromEntry && Number.isFinite(fromEntry.x) ? [[b.from, fromEntry]] : []);
    if (!members.length) continue;

    // **平移跟随**（08-25 用户报「跟随坏了」后改）：旧目标有座位时，整组按
    // 新旧目标的位移平移 —— 全员照挪、seat:user 也挪。用户拖动 = 调整相对
    // 格局（保留），不 = 取消跟随；旧行为（user 座罢工）在他把三张卡都拖过
    // 之后让 follow 永久死掉。要真停用有 unfollow。
    if (oldTarget && Number.isFinite(oldTarget.x)) {
      const dx = Math.round(target.x - oldTarget.x);
      const dy = Math.round(target.y - oldTarget.y);
      if (dx || dy) for (const [id, e] of members) objects[id] = { ...e, x: e.x + dx, y: e.y + dy };
      continue;
    }

    // 首跟（旧目标没座位可参照）：解一个位置放过去，只挪非 user 座
    const movable = members.filter(([, e]) => e.seat !== 'user');
    if (!movable.length) continue;
    const rects = members.map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
    const bb = {
      x: Math.min(...rects.map(r => r.x)), y: Math.min(...rects.map(r => r.y)),
      w: Math.max(...rects.map(r => r.x + r.w)) - Math.min(...rects.map(r => r.x)),
      h: Math.max(...rects.map(r => r.y + r.h)) - Math.min(...rects.map(r => r.y)),
    };
    const memberIds = new Set(members.map(([id]) => id));
    const obstacles = Object.entries(board.objects)
      .filter(([id, e]) => !memberIds.has(id) && id !== newId && Number.isFinite(e?.x) && layerOf(id, e, known) === targetZone)
      .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
    const p = resolvePlacement({
      box: { w: bb.w, h: bb.h }, anchor: targetRect, side: b.followSide || 'right',
      obstacles, contentBottom: 0,
    });
    const dx = Math.round(p.x - bb.x); const dy = Math.round(p.y - bb.y);
    if (!dx && !dy) continue;
    for (const [id, e] of movable) objects[id] = { ...e, x: e.x + dx, y: e.y + dy };
  }
  if (followed || Object.keys(objects).length) await patchBoard(projectId, { objects, bindings });
  return { followed };
}
