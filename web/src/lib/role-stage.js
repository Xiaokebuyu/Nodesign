/**
 * lib/role-stage.js —— 台上有哪些常驻角色，各自在写还是在等（2026-08-26）
 *
 * ## 为什么它跟 isStreaming 必须是两件事
 *
 * `isStreaming` 说的是「主对话被占用了」（按钮显停止、模型不能切）。
 * 这张表说的是「台上有人在演」。两者同时为真、同时为假、各自为真都成立。
 *
 * 混成一个的代价刚付过：服务端把角色开口误判成「主循环自发了一个回合」，铸出一个
 * 永远收不了的 run，于是侧栏卡在「停止」、点停止还连带杀掉在飞的其他角色
 *（病根与修法见 server/engine/runs/turn-relay.js 的 isBackgroundTurnOpener）。
 * 前端这侧的对策是：**别再让一个布尔背两件事**。
 *
 * ## 数据从哪来
 *
 * - `run.subagent.start` / `run.subagent.stop`：上场 / 下场（只认 `rp-` 开头的）
 * - `run.role.wait`：挂上 / 离开 `await_user`。⭐ 这条是**唯一**能分辨「在等你回话」
 *   和「已经没了」的信号 —— 角色挂着的时候事件流是静默的，没有它只能一直显工作态。
 *   上场事件可能被 stale 守卫吞掉，所以这条也兜底立条目。
 */

import { useState, useEffect } from 'react';
import { Assets } from './api.js';

/** 角色 slug 的判据跟服务端 cast.js 一致（前端只需要前缀这一层） */
const isRoleSlug = (s) => typeof s === 'string' && s.startsWith('rp-');

/**
 * 一条事件对台上名单的影响。
 * @param {Record<string, {waiting: boolean}>} stage
 * @param {object} evt
 * @returns {Record<string, {waiting: boolean}>} 没变化时**原样返回**（省一次渲染）
 */
export function reduceRoleStage(stage, evt) {
  const t = evt?.type;
  // 场声明（2026-08-27 编排）：模式/顺序/轮到谁。跟角色条目住同一张表（`__scene`
  // 保留键，isRoleSlug 天然隔开），侧栏提示和面板都从这一份读。
  if (t === 'run.scene') {
    return { ...stage, __scene: evt.scene || null };
  }
  if (t === 'run.role.wait') {
    if (!isRoleSlug(evt.slug)) return stage;
    const waiting = !!evt.waiting;
    if (stage[evt.slug]?.waiting === waiting) return stage;
    return { ...stage, [evt.slug]: { waiting } };
  }
  if (t === 'run.subagent.start') {
    if (!isRoleSlug(evt.agentType) || evt.agentType in stage) return stage;
    return { ...stage, [evt.agentType]: { waiting: false } };
  }
  if (t === 'run.subagent.stop') {
    if (!isRoleSlug(evt.agentType) || !(evt.agentType in stage)) return stage;
    const next = { ...stage };
    delete next[evt.agentType];
    return next;
  }
  // 角色卡写成/改稿（08-28 接上：此前前端零消费，re-cast 改名要等下一次上下场才刷新）
  // —— 记一个 tick，useRoleNames 据此重拉展示名
  if (t === 'run.role_cast') {
    return { ...stage, __castTick: (stage.__castTick || 0) + 1 };
  }
  return stage;
}

/**
 * 侧栏那行提示要显示什么。抽出来是为了能断言 —— 它是「对话到底能不能发消息」
 * 这个判断的用户可见面，说错一次用户就不敢打字了。
 * @returns {{label: string, allWaiting: boolean, count: number} | null} null = 台上没人
 */
export function stageHint(stage, roleNames = {}) {
  const slugs = Object.keys(stage || {}).filter(isRoleSlug);
  if (!slugs.length) return null;
  const nameOf = (s) => roleNames?.[s] || s;
  // 轮次进行中：直接说轮到谁 —— 这比「在写/在等」更该被用户看见
  const turn = stage.__scene?.turnSlug || null;
  return {
    count: slugs.length,
    label: slugs.length === 1 ? nameOf(slugs[0]) : `${nameOf(slugs[0])} 等 ${slugs.length} 人`,
    turnLabel: turn ? nameOf(turn) : null,
    // 全挂在 await_user 上 = 台上安静地等着；有一个没在等就算「在写」
    allWaiting: slugs.every((s) => stage[s]?.waiting),
  };
}

/** 当前的场声明（可能为 null）。__scene 由 run.scene 事件写入 */
export function sceneOf(stage) { return stage?.__scene || null; }

/**
 * 台上角色的展示名（slug → 名字）。台上名单一变补一次。
 *
 * **只在台上有人时才请求** —— 绝大多数会话根本没有角色，不该为这个多打一趟。
 * 查不到就让调用方退回 slug：宁可难看也不能张冠李戴（展示名住在角色文件里，
 * 而那份文件模型能改；保留字闸在服务端 listRoleNames 出口）。
 */
export function useRoleNames(projectId, stage) {
  const [names, setNames] = useState({});
  // 只看台上名单 + 角色卡改稿 tick（run.role_cast），__scene 变动不该触发重拉
  const key = Object.keys(stage || {}).filter(isRoleSlug).sort().join(',')
    + (stage?.__castTick ? `|c${stage.__castTick}` : '');
  useEffect(() => {
    if (!projectId || !key) return undefined;
    let alive = true;
    Assets.listRoles(projectId)
      .then((r) => {
        if (!alive || !Array.isArray(r?.roles)) return;
        setNames(Object.fromEntries(r.roles.map((x) => [x.slug, x.name || x.slug])));
      })
      .catch(() => { /* 名字取不到不挡演出 */ });
    return () => { alive = false; };
  }, [projectId, key]);
  return names;
}
