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
 * ## 判据为什么不能是「有活子代理就续命」
 *
 * 常驻角色的设计就是**永不收回合**：写完挂 await_user 候场，回合不结束（见
 * role-inbox.js 的散场闸注释）。拿「SubagentStart 过且没 SubagentStop」当判据，
 * 一个挂着候场的角色就能让会话永远关不掉 —— 每个 SDK 进程 ~250MB 且 RSS 单调不减，
 * 这台盒子 1vCPU/8G、swap=0。那不是修好一个洞，是换一个更贵的洞。
 *
 * 所以判据是 **在飞 − 候场**：候场的角色不算在干活，会话该回收就回收（角色本来
 * 就活不过会话，这是既有边界，不是这一刀新造的损失）。
 *
 * ## 两个信号都不是模型能写的
 *
 *   在飞  SubagentStart/SubagentStop —— harness 在 spawn / 结束那一刻亲眼所见并盖章
 *   候场  inbox 的 waiters —— 角色调 await_user 挂进去的，进出都由服务端记
 *
 * 判据不建在模型可写的东西上。
 *
 * ## 生命周期
 *
 * 会话内存态，runSession 的 finally 里跟收件箱一起清。**这里不设时间上限** ——
 * 兜底封顶在 ws/index.js 的续命次数上（一处判据一个真相源，别在两边各写一份）。
 */

import { agentNameOf } from './actor-trail.js';
import { isWaiting } from './inbox.js';

const flights = new Map();   // sessionId -> Map<agentId, { agentType, startedAt }>

/** 子代理起飞。agentId 来自 SubagentStart hook input，harness 盖的章 */
export function noteSubagentStart(sessionId, agentId, agentType = null) {
  if (!sessionId || !agentId) return;
  let m = flights.get(sessionId);
  if (!m) { m = new Map(); flights.set(sessionId, m); }
  m.set(agentId, { agentType, startedAt: Date.now() });
}

/** 子代理落地。⚠️ 角色挂 await_user 时**不会**走到这 —— 那是候场，见 workingSubagents */
export function noteSubagentStop(sessionId, agentId) {
  if (!sessionId || !agentId) return;
  const m = flights.get(sessionId);
  if (!m) return;
  m.delete(agentId);
  if (m.size === 0) flights.delete(sessionId);
}

/**
 * 这个会话里**真在干活**的后台子代理。
 *
 * 候场判定要把 agentId 翻成实例名（收件箱按实例名开坑，hook 只给 agent_type=rp-actor，
 * 中间隔着别名桥）。翻不出名字的按「在干活」算：普通后台子代理没有候场形态，
 * 而漏判成候场 = 又一次腰斩，两种错的代价不对称。
 *
 * @returns {Array<{ agentId, agentType, name, startedAt }>}
 */
export function workingSubagents(sessionId, projectId = null) {
  const m = flights.get(sessionId);
  if (!m || m.size === 0) return [];
  const out = [];
  for (const [agentId, info] of m) {
    const name = agentNameOf(agentId);
    if (projectId && name && isWaiting(projectId, name)) continue;   // 候场，不算干活
    out.push({ agentId, name, ...info });
  }
  return out;
}

/** 会话收摊（跟 inbox.clearProject 一起调） */
export function clearSessionFlights(sessionId) { flights.delete(sessionId); }

/** 测试用：清空全局态 */
export function _resetSubagentFlight() { flights.clear(); }
