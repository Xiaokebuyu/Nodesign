/**
 * engine/agent/subagent-flight.js —— 「这个会话还有后台角色在干活吗」（2026-08-28）
 *
 * ## 为什么需要这条路
 *
 * ws/index.js 的 grace 闸（07-27 建）只认 turn：用户关 tab / 切走后 turn 还在飞就
 * 续命，等它干完再回收 SDK 进程。演员位范式造出了**第二种在飞工作** —— GM 的场务
 * turn 几秒钟就结束，后台角色还要写好几分钟。闸不认识它，于是 08-28 泉此方场实录：
 *
 *   17:47:39 角色派出 → 17:48:17 GM turn 结束 → 17:49:29 grace 到期关会话
 *   → 角色被腰斩在第三个 Read 上，板上永远没有第二拍，日志里连个 warn 都没有。
 *
 * 从用户视角看就是「角色不写了」。这正是 07-27 那道闸要保住的东西（"用户关 tab 时
 * 后端应该把活干完"），只是当时在飞工作只有 turn 一种形态。
 *
 * ## 判据（2026-08-29 简化）
 *
 * **在飞 = SubagentStart 过且 SubagentStop 还没到**，就这一条。
 *
 * 08-29 之前它还要减掉「候场」——那时角色写完一段会挂在 await_user 上不收回合，
 * 一个挂着的角色就能让会话永远关不掉（每个 SDK 进程 ~250MB 且 RSS 单调不减，
 * 这台盒子 1vCPU/8G、swap=0）。新回路里角色写一段就结束这一轮，「永不收回合」这个
 * 形态不存在了，减数也就跟着没了。
 *
 * 信号是 harness 在 spawn / 结束那一刻亲眼所见并盖的章，不是模型能写的东西。
 *
 * ## 生命周期
 *
 * 会话内存态，runSession 的 finally 里跟收件箱一起清。**这里不设时间上限** ——
 * 兜底封顶在 ws/index.js 的续命次数上（一处判据一个真相源，别在两边各写一份）。
 */

import { agentNameOf } from './actor-trail.js';

const flights = new Map();   // sessionId -> Map<agentId, { agentType, startedAt }>

/** 子代理起飞。agentId 来自 SubagentStart hook input，harness 盖的章 */
export function noteSubagentStart(sessionId, agentId, agentType = null) {
  if (!sessionId || !agentId) return;
  let m = flights.get(sessionId);
  if (!m) { m = new Map(); flights.set(sessionId, m); }
  m.set(agentId, { agentType, startedAt: Date.now() });
}

/** 子代理落地 */
export function noteSubagentStop(sessionId, agentId) {
  if (!sessionId || !agentId) return;
  const m = flights.get(sessionId);
  if (!m) return;
  m.delete(agentId);
  if (m.size === 0) flights.delete(sessionId);
}

/**
 * 这个会话里还在飞的后台子代理。
 *
 * name 是实例名（角色）——翻不出来的（普通干活子代理）也照样算在飞，只是没名字。
 *
 * @param {string} sessionId
 * @param {string|null} _projectId  旧签名的兼容位（候场判定退役后不再需要）
 * @returns {Array<{ agentId, agentType, name, startedAt }>}
 */
export function workingSubagents(sessionId, _projectId = null) {
  const m = flights.get(sessionId);
  if (!m || m.size === 0) return [];
  return [...m].map(([agentId, info]) => ({ agentId, name: agentNameOf(agentId), ...info }));
}

/** 会话收摊 */
export function clearSessionFlights(sessionId) { flights.delete(sessionId); }

/** 测试用：清空全局态 */
export function _resetSubagentFlight() { flights.clear(); }
