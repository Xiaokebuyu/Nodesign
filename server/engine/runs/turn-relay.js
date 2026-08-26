/**
 * server/engine/runs/turn-relay.js — run 记录 ↔ 用户消息的配对（2026-08-20 从
 * active-runs.js 拆出，行数棘轮）。
 *
 * 管的只有一件事：turn.js 为每条用户消息建的 run 行，怎样在 streamInput 模式下跟
 * SDK 流里的 turn 边界对上号。会话记录（currentRunId / pendingRunIds / runIdByUuid）
 * 仍归 active-runs.js 所有（registerQuerySession 初始化、unregister 清理），这里只读写
 * 它的这几个字段 —— 所以本模块 import active-runs，反向不 import（无环）。
 *
 * 下面 claimRunByUuid 上方的长注释是整套机制与探针证据，改任何一处前先读它。
 */

import { randomUUID } from 'node:crypto';
import { getQuerySession } from './active-runs.js';
import { markRunStarted, markRunSucceeded, mergeRunMetadata } from './store.js';

/**
 * 推一条 user message 到 session 的 input queue + 标记当前 turn runId。
 * runSession for-await-of 那头会拉到这条 message → SDK 处理 → 出 result message
 * → runSession 用 currentRunId 做 markRunSucceeded / emit run.done。
 *
 * @param {string} sessionId
 * @param {string} runId  - 当前 turn 的 run record id（前端 UI 跟踪用）
 * @param {object} sdkUserMessage  - { type:'user', message:{role,content}, parent_tool_use_id }
 * @returns {boolean} true=成功 push
 */
export function pushUserMessage(sessionId, runId, sdkUserMessage) {
  const rec = getQuerySession(sessionId);
  if (!rec) return false;
  if (rec.abortController.signal.aborted) return false;
  // runId 关联（2026-08-20 重做，背景见文件尾「run 记账错位案」）：
  //   - 出站消息盖 uuid 章。SDKUserMessage 的 uuid 字段是 SDK 类型里的合法可选项，
  //     CLI 回显时原样带回，是 runId ↔ 消息唯一可靠的配对键。
  //   - session idle 且没人排队 → 直接设 currentRunId，SDK 拉到消息即处理。
  //   - 否则一律**排队**，不抢占 currentRunId。两种情形都排：① turn 进行中
  //     （老逻辑立即覆盖会让 session-loop 的 turn 边界检测把还在跑的 turn1 误判成
  //     TURN_LEAK 标 failed，turn2 又没有 run.start/run.done —— 前端表现"stop 按钮
  //     消失但字还在冒"）；② turn 刚结束、前面还有排队的消息没被 CLI 回显
  //     （此刻 currentRunId 是空的，但 CLI 队列是 FIFO，它下一条要处理的是前面那条
  //     —— 这条若直接上位，回显到了就会把前面那条误判成"并进了这条"）。
  //   - 排队的 runId **不再靠 finishTurn 计数晋升**，由它自己的回显来认领
  //     （claimRunByUuid）。
  if (!sdkUserMessage.uuid) sdkUserMessage.uuid = randomUUID();
  rec.runIdByUuid.set(sdkUserMessage.uuid, runId);
  if (!rec.currentRunId && rec.pendingRunIds.length === 0) {
    rec.currentRunId = runId;
  } else {
    rec.pendingRunIds.push(runId);
  }
  rec.lastActivityAt = Date.now();
  try {
    rec.inputQueue.push(sdkUserMessage);
    return true;
  } catch (err) {
    console.warn(`[active-runs] pushUserMessage failed for ${sessionId}: ${err.message}`);
    return false;
  }
}

/**
 * ## run 记账错位案（2026-08-19 定案，08-20 修）
 *
 * 老接力：`result` 到 → finishTurn(当前) → promoteNextPendingRunId 晋升队头。
 * 前提是「一条用户消息严格对应一个 result」。但 CLI 在 streamInput 模式下会把
 * turn 进行中追加的消息**并进正在跑的这一轮**（默认 priority 'next'；探针
 * `server/_probe-turn-merge.mjs` 实测：一个 result、num_turns=3、两条都答了）。
 * 发生一次，链就永久错一格且永不自愈 —— 之后每个 result 关的都是上一条的 run，
 * runs 表里每条 started_at/finished_at 其实是下一轮的执行窗口（"排队 7-12 分钟"
 * 的假象）；前端等的 run.start 迟一轮才发/最后一条永不发（追加后丢状态）。
 *
 * 新锚：CLI 开 `--replay-user-messages` 后回显每条用户消息，**回显时刻 = 那条
 * 消息真正被并进对话的时刻**（探针实测：push 后 2.5s，回显在 12s 后 tool_result
 * 回来、下一次模型调用之前到；不是读到 stdin 就回）。于是：
 *   - 回显到、此刻没有 turn 在跑 → 这条 run 的 turn 开始了（晋升）
 *   - 回显到、turn 进行中 → 这条被并进了当前轮（就地关账，metadata 记 mergedIntoRunId）
 * 并轮语义**保留不改**（`priority:'later'` 可让 CLI 排到下一轮不并，探针验过，
 * 但"追加立刻被看见"是更好的体验，跟 Claude Code 自己一致）。
 */

/**
 * 推一条**不认领 run** 的用户消息（08-21 晚，半截续接用）。
 *
 * 跟 pushUserMessage 的区别：不盖 uuid 章、不进 runIdByUuid、不碰 currentRunId/pendingRunIds。
 * 因为它不是用户发的新一轮，而是**当前这一轮的延续** —— 半截被掐了，我们替 agent 说一句
 * "接着说"。调用方（session-loop）此刻还没 finishTurn，currentRunId 仍是这一轮，
 * 于是 CLI 回显它时 claimRunByUuid 返 null（不是我们盖章的消息，照旧忽略），
 * turn 边界检测也不动（cid 没变）—— 整段续接算在同一个 run 里，token 照常累加。
 *
 * ⚠️ 别拿 pushUserMessage 干这件事：它会把 runId 塞进 pendingRunIds，而这个 runId
 * 已经是 currentRunId，回显时走 'current' 分支不出队 —— 队列里那条永远清不掉，
 * 前端"已排队 1 条"会一直亮着，还会误触发回显锚缺席的 FIFO 兜底。
 *
 * @returns {boolean} true = 推进队列了
 */
export function pushUnclaimedMessage(sessionId, sdkUserMessage) {
  const rec = getQuerySession(sessionId);
  if (!rec) return false;
  if (rec.abortController.signal.aborted) return false;
  rec.lastActivityAt = Date.now();
  try {
    rec.inputQueue.push(sdkUserMessage);
    return true;
  } catch (err) {
    console.warn(`[turn-relay] pushUnclaimedMessage failed for ${sessionId}: ${err.message}`);
    return false;
  }
}

/**
 * 回显到了一条带 uuid 的用户消息 → 认领它对应的 run。
 *
 * @param {string} sessionId
 * @param {string} uuid  回显消息的 uuid
 * @returns {null | { runId: string, outcome: 'current' | 'promoted' | 'merged' | 'unknown', intoRunId?: string }}
 *   null = 不是我们盖过章的消息（首条经 initialRunId 走、或 CLI 合成的）；
 *   current = 它本来就是当前 run（idle 直设 / FIFO 兜底已晋升）；
 *   promoted = 从排队晋升为当前 run（调用方接着 startTurn）；
 *   merged = 并进了正在跑的 intoRunId（调用方就地关账）；
 *   unknown = 盖过章但已不在排队里（理论上不该发生，留给日志）。
 */
export function claimRunByUuid(sessionId, uuid) {
  const rec = getQuerySession(sessionId);
  if (!rec || !uuid) return null;
  const runId = rec.runIdByUuid.get(uuid);
  if (!runId) return null;
  rec.runIdByUuid.delete(uuid);
  if (runId === rec.currentRunId) return { runId, outcome: 'current' };
  const idx = rec.pendingRunIds.indexOf(runId);
  if (idx < 0) return { runId, outcome: 'unknown' };
  rec.pendingRunIds.splice(idx, 1);
  if (!rec.currentRunId) {
    rec.currentRunId = runId;
    return { runId, outcome: 'promoted' };
  }
  return { runId, outcome: 'merged', intoRunId: rec.currentRunId };
}

/**
 * turn 结束：让出 currentRunId（session-loop finishTurn 调）。
 * 排队的下一条**不在这里晋升** —— 等它自己的回显（claimRunByUuid）。
 *
 * @param {string} sessionId
 */
export function releaseCurrentTurnRunId(sessionId) {
  const rec = getQuerySession(sessionId);
  if (!rec) return;
  rec.currentRunId = null;
}

/**
 * FIFO 兜底：回显锚缺席时（CLI 没开 replay / 版本行为变了）按队头晋升，
 * 否则排队的 run 永远没人认领、整轮事件全丢。session-loop 只在"没 turn 在跑、
 * 有人排队、模型却已经在说话"时调它，并打 warn —— 正常运行下不该走到。
 *
 * @param {string} sessionId
 * @returns {string|null} 晋升后的 currentRunId
 */
export function promoteNextPendingRunId(sessionId) {
  const rec = getQuerySession(sessionId);
  if (!rec) return null;
  if (rec.currentRunId) return rec.currentRunId;
  rec.currentRunId = rec.pendingRunIds.shift() || null;
  return rec.currentRunId;
}

/**
 * @param {string} sessionId
 * @returns {number} 排队中（已 push、还没被 CLI 回显认领）的 run 数
 */
export function getPendingRunCount(sessionId) {
  return getQuerySession(sessionId)?.pendingRunIds.length || 0;
}

/**
 * 取 inputQueue 当前积压深度（push 但尚未被 SDK pull 的 message 数）。
 * 给前端显示"已排队 N 条"用。
 *
 * 0 = agent idle 立即处理；>0 = agent 还在忙，下一条要排队
 *
 * @param {string} sessionId
 * @returns {number}
 */
export function getQueueDepth(sessionId) {
  // 2026-08-20 改口径：老值是 inputQueue.size，但 SDK 一有消息就拉走（它自己往 CLI
  // stdin 写，排队发生在 CLI 进程里），这个数基本恒为 0 —— "已排队 N 条"从没亮过。
  // 现在 N = 已 push、还没被 CLI 回显认领的 run 数，这才是用户那句"agent 还没接上
  // 我这条"的真相。
  return getPendingRunCount(sessionId);
}

/**
 * 并轮关账（session-loop 的回显锚在 outcome==='merged' 时调）。
 * 回显到了一条排队消息、而 turn 正在跑 = CLI 把它并进了当前轮。它的 run 行不能
 * 停在 pending（那就是老病：runs 表里"排队 N 分钟"的假象），也不能等一个永远不来
 * 的 result。就地 running→succeeded，metadata 记它并进了谁；token/费用全记在承载它
 * 的那一轮（SDK 的 result 本来就只给一份）。run.merged 事件给前端/审计看，前端
 * 现在不消费（追加那条从没被认领过 runId，不需要清状态）。
 */
export function closeMergedRun({ runId, intoRunId, sessionId, sdkSessionId, eventBus }) {
  try { markRunStarted(runId); } catch { /* 不该已 running；兜底继续关 */ }
  try {
    mergeRunMetadata(runId, { mergedIntoRunId: intoRunId, sdkSessionId });
    markRunSucceeded(runId, {});
  } catch (err) {
    console.warn(`[turn-relay] sid=${sessionId.slice(0, 8)} close merged run=${runId} failed: ${err.message}`);
  }
  console.info(`[turn-relay] sid=${sessionId.slice(0, 8)} run=${runId} merged into running turn run=${intoRunId}`);
  eventBus.publish({ type: 'run.merged', sessionId, runId, intoRunId, ts: new Date().toISOString() });
}

/**
 * 广播"已排队 N 条"（N = 还没被 CLI 回显认领的 run 数，见 getQueueDepth）。
 * 认领一条广播一次让前端递减；turn 处理完也广播。
 */
export function publishQueueDepth(eventBus, sessionId) {
  eventBus.publish({ type: 'run.queue.depth', sessionId, depth: getQueueDepth(sessionId), ts: new Date().toISOString() });
}

/**
 * 这条 SDK 消息算不算「自发了一个没主的回合」（session-loop 据此 mintBackgroundTurn）。
 *
 * ⛔ **子代理说话不算**（2026-08-26 用户真机复现）：判据原来只看 type，于是常驻角色
 * 被用户的直达消息唤醒、开口第一句时就铸出一个主回合并 emit run.start。而那个 run
 * **永远收不了** —— 角色跑的是子代理回合，不会有主循环的 result，finishTurn /
 * releaseCurrentTurnRunId 都轮不到。连锁四个症状：
 *   1. 侧栏按钮变「停止」，用户以为对话被占用
 *   2. currentTurnRunId 挂死 → 每次重连 ws 的 activeRunId 又把「停止」确认一遍，回不去
 *   3. 点「停止」= cancel 那个铸出来的 run → SDK abort 把**在飞的其他角色一起杀了**
 *   4. 时间轴上多一条永远转的圈
 *
 * 后台自发回合这条路本身是对的（task_notification 唤起主代理时确实没主），
 * 它只是分不出「主代理醒了」和「子代理说话了」—— 用 parent_tool_use_id 分。
 */
export function isBackgroundTurnOpener(message) {
  if (message?.parent_tool_use_id) return false;
  return message?.type === 'assistant'
    || message?.type === 'stream_event'
    || message?.type === 'user';
}
