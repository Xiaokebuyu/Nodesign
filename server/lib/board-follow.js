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
 * - 挪组连 seat:'user' 一起（08-28 全放开）：平移保相对格局本来就是这条线先证明的；
 *   首跟也不再把用户件留在原地（撕组比挪用户件更丑）。
 * - fail-soft：跟随失败绝不连累落板本身。
 */

import { readBoard, patchBoard } from '../projects/board-store.js';
import { estimateSizeOn } from './board-kind-sizes.js';
import { layerOf } from './canvas-id.js';
import { placeBeside } from './board-sheets.js';
import { UNIT } from './rect.js';

/**
 * 某 tag 有新件落板：把所有 follow 这个 tag 的线重指到 newId，并挪各自的组。
 * @returns {Promise<{followed: number}>}
 */
export async function applyFollows(projectId, { tag, newId }) {
  if (!tag || !newId) return { followed: 0 };
  const board = await readBoard(projectId);
  const followers = Object.entries(board.bindings || {})
    .filter(([, b]) => b.follow === tag && b.to !== newId);
  /**
   * 挂账的跟随规则兑现（2026-08-30）：`board.follows` 里目标是本 tag、但还没有线的，
   * 现在这一刻目标第一次出现 —— 当场把线补出来，交给下面同一段几何走「首跟」。
   *
   * 规则和线分开存就是为了这一刻：立规则时目标可以是空的（skill 教的顺序如此），
   * 线只在两端都真实存在时才有意义。
   */
  for (const [groupTag, rule] of Object.entries(board.follows || {})) {
    if (rule?.target !== tag) continue;
    const already = Object.entries(board.bindings || {})
      .some(([, b]) => b.follow === tag && board.objects?.[b.from]?.tag === groupTag);
    if (already) continue;
    const member = Object.entries(board.objects || {})
      .filter(([, e]) => e?.tag === groupTag && Number.isFinite(e?.x))
      .sort((a, b) => a[1].y - b[1].y)[0];
    if (!member || member[0] === newId) continue;
    followers.push([`b:f${Date.now().toString(36)}${groupTag.length}`, {
      type: 'annotates', from: member[0], to: '', by: 'agent',
      label: rule.label || '跟随', follow: tag, ...(rule.side ? { followSide: rule.side } : {}),
    }]);
  }
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

    // 首跟（旧目标没座位可参照）：解一个位置整组放过去（08-28 起含 user 座 —— 撕组更丑）
    const movable = members;
    if (!movable.length) continue;
    const rects = members.map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
    const bb = {
      x: Math.min(...rects.map(r => r.x)), y: Math.min(...rects.map(r => r.y)),
      w: Math.max(...rects.map(r => r.x + r.w)) - Math.min(...rects.map(r => r.x)),
      h: Math.max(...rects.map(r => r.y + r.h)) - Math.min(...rects.map(r => r.y)),
    };
    // 首跟 = 精确贴放（2026-08-29 纸范式：环搜退役）。跟随组的位置本来就该
    // 紧贴目标的固定一侧 —— 压上什么由之后的平移跟随自然化解，不代找洞。
    void targetZone; void known;
    const p = placeBeside(targetRect, { w: bb.w, h: bb.h }, b.followSide || 'right', UNIT);
    const dx = Math.round(p.x - bb.x); const dy = Math.round(p.y - bb.y);
    if (!dx && !dy) continue;
    for (const [id, e] of movable) objects[id] = { ...e, x: e.x + dx, y: e.y + dy };
  }
  if (followed || Object.keys(objects).length) await patchBoard(projectId, { objects, bindings });
  return { followed };
}
