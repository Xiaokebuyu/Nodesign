/**
 * server/engine/runs/active-runs.js — 活跃 run registry
 *
 * 为什么需要：
 *   loop.js 的 ctx.abortController / ctx 是 in-memory 实例，外部（HTTP cancel
 *   endpoint）需要根据 runId 找到对应的引用才能控制。
 *
 * 工作流：
 *   1. runAgent 启动时立即 registerRun(runId, { abortController, ctx })
 *      —— 此时 query 还没调，先注册让 cancel race condition 兜底
 *   2. query() 拿到 handle 后调 attachQuery(runId, query)
 *      —— 之后 control 方法（interrupt/setModel/rewindFiles/...）可用
 *   3. 用户点"停止"→ POST /api/projects/:pid/runs/:runId/cancel
 *      → cancelRun(runId) 三条路径：
 *         a. query.interrupt() 优雅 + 5s 后兜底 ctx.cancel()
 *         b. interrupt 失败兜底 ctx.cancel()
 *         c. race window（query 还没 attach）→ 直接 ctx.cancel()
 *   4. ctx.cancel() 幂等：set abort signal + emit run.cancelled（前端据此 setIsStreaming(false)）
 *   5. SDK 看到 abort signal 或 interrupt → query 中断
 *      → loop.js 走 cancelled 路径或 catch
 *   6. runAgent finally 调 unregisterRun(runId)（无论成功失败）
 *
 * 暴露给上层（API/前端）的能力（通过 getQuery）：
 *   - query.interrupt()                 优雅中断
 *   - query.setModel(model?)            运行时切模型
 *   - query.setPermissionMode(mode)     运行时切权限模式
 *   - query.getContextUsage()           真实上下文水位
 *   - query.mcpServerStatus()           MCP 连接状态
 *   - query.rewindFiles(uuid, opts?)    file checkpoint 回滚（per user message）
 *   - query.toggleMcpServer(name, on)   动态启停 MCP server
 *   - query.stopTask(taskId)            停后台子代理任务
 *   - query.streamInput(stream)         追加 user message（多轮复用）
 *   - 等等（见 sdk.d.ts:2017 Query interface）
 *
 *   ⚠️ 这些 control 方法**只在 streaming input/output 模式下可用**
 *      （sdk.d.ts:2018-2022）。loop.js 已统一把所有 prompt 包成
 *      AsyncIterable<SDKUserMessage>，符合此前提。
 *
 * Map 是 in-memory：服务重启 controller / ctx 都没了（活跃 run 也都死了，一致）。
 * 多实例部署时需要分布式协调（Redis pub/sub），stage 1 单进程够用。
 */

/**
 * @typedef {object} PendingQuestion
 * @property {(answers: Record<string, string>) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {number} createdAt
 */

/**
 * @typedef {object} ActiveRunRecord
 * @property {AbortController} abortController
 * @property {import('../agent/context.js').AgentContext} ctx  - AgentContext 引用，cancelRun 走 ctx.cancel() 统一 emit run.cancelled
 * @property {import('@anthropic-ai/claude-agent-sdk').Query|null} query  - query handle，先注册时为 null，attachQuery 后填
 * @property {Map<string, PendingQuestion>} pendingQuestions - A4.1：tool_use_id → Promise resolver，AskUserQuestion 等用户答案用
 * @property {Map<string, PendingQuestion>} pendingElicitations - Phase 2.3：reqId → Promise resolver，MCP onElicitation 等用户答案用
 * @property {number} startedAt
 */

/** @type {Map<string, ActiveRunRecord>} */
const activeRuns = new Map();

/**
 * @typedef {object} ActiveQuerySession  - per-sid long-running query（streamInput 模式）
 * @property {AbortController} abortController  - session 级；close session 时触发
 * @property {import('../agent/context.js').AgentContext|null} ctx  - 当前 turn 的 ctx（per-turn 切换）
 * @property {import('@anthropic-ai/claude-agent-sdk').Query|null} query
 * @property {import('../../lib/async-queue.js').AsyncQueue} inputQueue  - SDK 消费 user message 的源
 * @property {string|null} currentRunId  - 当前正处理的 turn run record id
 * @property {Map<string, PendingQuestion>} pendingQuestions  - tool_use_id → resolver
 * @property {Map<string, PendingQuestion>} pendingElicitations
 * @property {number} startedAt
 */

/** @type {Map<string, ActiveQuerySession>} */
const activeQuerySessions = new Map();

/**
 * 注册 run。runAgent 启动后立即调（query 还没拿到 handle）。
 * 后续在 loop.js 拿到 query handle 后调 attachQuery 把 query 填上。
 *
 * @param {string} runId
 * @param {object} deps
 * @param {AbortController} deps.abortController
 * @param {import('../agent/context.js').AgentContext} deps.ctx  - 必传，cancelRun 通过它调 ctx.cancel() 统一 emit run.cancelled
 */
export function registerRun(runId, { abortController, ctx } = {}) {
  if (!runId || !abortController) return;
  activeRuns.set(runId, {
    abortController,
    ctx: ctx || null,
    query: null,
    pendingQuestions: new Map(),
    pendingElicitations: new Map(),
    startedAt: Date.now(),
  });
}

/**
 * 把 query handle attach 到已注册的 run。
 * loop.js 在 `const stream = query({ ... })` 之后立即调。
 *
 * 之所以分两步注册：query() 调用之前 cancel race（用户极快点停止）能拿到
 * abortController/ctx 兜底；query() 之后 cancel 走 query.interrupt() 优雅路径。
 *
 * @param {string} runId
 * @param {import('@anthropic-ai/claude-agent-sdk').Query} query
 */
export function attachQuery(runId, query) {
  const rec = activeRuns.get(runId);
  if (!rec) return;
  rec.query = query;
}

/**
 * 注销 run（无论 succeeded / failed / cancelled）。
 * loop.js runAgent finally 调，避免引用泄漏。
 *
 * A4.1：reject 任何剩余 pendingQuestions（防止 Promise 永久 hang
 * 让 canUseTool callback 卡死整个 SDK loop 释放）。
 */
export function unregisterRun(runId) {
  if (!runId) return;
  const rec = activeRuns.get(runId);
  if (rec?.pendingQuestions) {
    for (const [, p] of rec.pendingQuestions) {
      try { p.reject(new Error('run ended before user answered question')); } catch { /* ignore */ }
    }
    rec.pendingQuestions.clear();
  }
  if (rec?.pendingElicitations) {
    for (const [, p] of rec.pendingElicitations) {
      try { p.reject(new Error('run ended before MCP elicitation answered')); } catch { /* ignore */ }
    }
    rec.pendingElicitations.clear();
  }
  activeRuns.delete(runId);
}

/**
 * A4.1：注册一个等待用户答案的 Promise。
 * loop.js canUseTool 拦到 AskUserQuestion 时调，emit 事件后 await 返回的
 * Promise；用户在前端点选项 → POST /answer → provideAnswer → resolve。
 *
 * 同 toolUseId 重复 register 视作上一个被覆盖（reject 旧的 + 新建）—— 实际
 * 不应发生（每个 tool_use_id 只 ask 一次），保险处理。
 *
 * 也会监听 abortController.signal —— run cancel 时 reject Promise，让
 * canUseTool 抛错让 SDK 走 cancelled 路径。
 *
 * @param {string} runId
 * @param {string} toolUseId  - SDK 的 tool_use_id（canUseTool options.toolUseID）
 * @returns {Promise<Record<string, string>>}  - resolve 时返回 answers map（question text → label）
 */
export function registerPendingQuestion(runId, toolUseId) {
  // streamInput 模式优先：runId 是某个 active query session 的 currentRunId →
  // 用 session 级 pendingQuestions Map（绑 sessionAbortController 寿命）
  const sessionRec = findQuerySessionByRunId(runId);
  const rec = sessionRec || activeRuns.get(runId);
  if (!rec) return Promise.reject(new Error(`run ${runId} not active (no session, no per-turn run)`));
  if (!toolUseId) return Promise.reject(new Error('toolUseId required'));

  // 若已存在同 toolUseId 的 pending：reject 旧的避免漏 reject
  const existing = rec.pendingQuestions.get(toolUseId);
  if (existing) {
    try { existing.reject(new Error('superseded by new question with same toolUseId')); } catch { /* ignore */ }
  }

  return new Promise((resolve, reject) => {
    rec.pendingQuestions.set(toolUseId, {
      resolve: (answers) => {
        rec.pendingQuestions.delete(toolUseId);
        resolve(answers);
      },
      reject: (err) => {
        rec.pendingQuestions.delete(toolUseId);
        reject(err);
      },
      createdAt: Date.now(),
    });

    // session-level / run-level abort → reject pending（防 canUseTool 永久挂）
    const onAbort = () => {
      const p = rec.pendingQuestions.get(toolUseId);
      if (p) {
        rec.pendingQuestions.delete(toolUseId);
        reject(new Error(`aborted before user answered: ${rec.abortController.signal.reason || 'unknown'}`));
      }
    };
    if (rec.abortController.signal.aborted) {
      onAbort();
    } else {
      rec.abortController.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** runId → activeQuerySession（streamInput 模式）；找不到返 undefined */
function findQuerySessionByRunId(runId) {
  for (const [, qRec] of activeQuerySessions) {
    if (qRec.currentRunId === runId) return qRec;
  }
  return undefined;
}

/**
 * Phase 2.3：注册一个等待 MCP elicitation 答案的 Promise。
 * loop.js onElicitation 回调拦到 MCP server elicit 请求时调，emit 事件后 await
 * 返回的 Promise；用户在前端答完 → POST /elicit/:reqId/answer → provideElicitation。
 *
 * @param {string} runId
 * @param {string} reqId  - host 端生成的 elicitation 请求 id
 * @returns {Promise<import('@anthropic-ai/claude-agent-sdk').ElicitationResult>}
 */
export function registerPendingElicitation(runId, reqId) {
  const sessionRec = findQuerySessionByRunId(runId);
  const rec = sessionRec || activeRuns.get(runId);
  if (!rec) return Promise.reject(new Error(`run ${runId} not active (no session, no per-turn run)`));
  if (!reqId) return Promise.reject(new Error('reqId required'));

  const existing = rec.pendingElicitations.get(reqId);
  if (existing) {
    try { existing.reject(new Error('superseded by new elicitation with same reqId')); } catch { /* ignore */ }
  }

  return new Promise((resolve, reject) => {
    rec.pendingElicitations.set(reqId, {
      resolve: (result) => {
        rec.pendingElicitations.delete(reqId);
        resolve(result);
      },
      reject: (err) => {
        rec.pendingElicitations.delete(reqId);
        reject(err);
      },
      createdAt: Date.now(),
    });

    const onAbort = () => {
      const p = rec.pendingElicitations.get(reqId);
      if (p) {
        rec.pendingElicitations.delete(reqId);
        reject(new Error(`run aborted before elicitation answered: ${rec.abortController.signal.reason || 'unknown'}`));
      }
    };
    if (rec.abortController.signal.aborted) {
      onAbort();
    } else {
      rec.abortController.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Phase 2.3：用户答完 MCP elicitation，由 POST /elicit/:reqId/answer endpoint 调。
 *
 * @param {string} runId
 * @param {string} reqId
 * @param {import('@anthropic-ai/claude-agent-sdk').ElicitationResult} result
 *   - { action: 'accept', content?: {...} } / { action: 'cancel' } / { action: 'decline' }
 * @returns {boolean}
 */
export function provideElicitation(runId, reqId, result) {
  const sessionRec = findQuerySessionByRunId(runId);
  const rec = sessionRec || activeRuns.get(runId);
  if (!rec) return false;
  const p = rec.pendingElicitations.get(reqId);
  if (!p) return false;
  try {
    p.resolve(result);
    return true;
  } catch {
    return false;
  }
}

/**
 * A4.1：用户在前端答完问题，由 POST /answer endpoint 调。
 * resolve 对应 toolUseId 的 Promise，唤醒 canUseTool callback 让它返回
 * updatedInput。
 *
 * @param {string} runId
 * @param {string} toolUseId
 * @param {Record<string, string>} answers  - { [question text]: option label }（multi-select 用 ", " 拼接）
 * @returns {boolean} true=resolved；false=run/toolUseId 不存在或已 resolve
 */
export function provideAnswer(runId, toolUseId, answers) {
  const sessionRec = findQuerySessionByRunId(runId);
  const rec = sessionRec || activeRuns.get(runId);
  if (!rec) return false;
  const p = rec.pendingQuestions.get(toolUseId);
  if (!p) return false;
  try {
    p.resolve(answers);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取回完整 record（abortController + ctx + query handle + startedAt）。
 * 上层 API endpoint 可用：rewind / setModel / getContextUsage 等都通过 record.query 调。
 *
 * @returns {ActiveRunRecord | undefined}
 */
export function getRun(runId) {
  return activeRuns.get(runId);
}

/**
 * 快捷方法：拿 query handle。
 * @returns {import('@anthropic-ai/claude-agent-sdk').Query | null | undefined}
 */
export function getQuery(runId) {
  return activeRuns.get(runId)?.query;
}

/**
 * 取消活跃 run。
 *
 * Phase 3c 升级：
 *   优先 query.interrupt() 优雅中断 —— agent 能写完当前 token 块再停。
 *   SDK 收到 interrupt 后 query 自然结束，推 SDKResultMessage 含
 *   terminal_reason: 'aborted_streaming' | 'aborted_tools'（sdk.d.ts:5339），
 *   loop.js result 处理识别后调 ctx.cancel() emit run.cancelled。
 *
 *   5s 兜底 ctx.cancel()：interrupt 后 SDK 偶尔会卡住（reasoning 进行中），
 *   timeout 兜底强制 abort + emit run.cancelled，前端不会卡 streaming。
 *
 * 三条路径全部走 ctx.cancel()（幂等）保证 run.cancelled 恰好 emit 一次：
 *   a. interrupt 成功 → loop.js result 路径调 ctx.cancel()
 *   b. interrupt 失败兜底 → cancelRun 直接调 ctx.cancel()
 *   c. race window（query 还没 attach）→ cancelRun 直接调 ctx.cancel()
 *
 * @param {string} runId
 * @param {string} reason - 写入 abort signal.reason，loop.js cancelled 路径会读
 * @returns {boolean} true=成功 trigger；false=run 不在 registry（已结束 / 不存在）
 */
export function cancelRun(runId, reason = 'user_cancel') {
  // streamInput 模式优先：runId 是某个 active query session 的 currentRunId →
  // 调 session.query.interrupt() 中断当前 turn，query 不死继续等下条 message
  for (const [sid, qRec] of activeQuerySessions) {
    if (qRec.currentRunId === runId) {
      if (qRec.query && typeof qRec.query.interrupt === 'function') {
        qRec.query.interrupt().catch((err) => {
          console.warn(`[active-runs] query.interrupt failed for run ${runId} in session ${sid.slice(0, 8)}:`, err?.message);
          // 失败兜底：close 整个 session（用户预期 stop 起码能停下来）
          closeQuerySession(sid, reason + ':interrupt_failed');
        });
      } else {
        // race：query handle 还没 attach（runSession 启动 race window）
        // 直接 close session 兜底
        console.warn(`[active-runs] cancelRun race: query handle not yet attached for ${sid.slice(0, 8)}, closing session`);
        closeQuerySession(sid, reason + ':no_query_handle');
      }
      return true;
    }
  }

  // 老路径（per-turn runAgent）—— activeRuns 里的 record
  const rec = activeRuns.get(runId);
  if (!rec) return false;

  if (rec.query && typeof rec.query.interrupt === 'function') {
    rec.query.interrupt().catch((err) => {
      console.warn(`[active-runs] query.interrupt failed for ${runId}:`, err?.message);
      cancelViaCtxOrAbort(rec, reason);
    });
    setTimeout(() => {
      const stillActive = activeRuns.get(runId);
      if (stillActive && stillActive === rec) {
        cancelViaCtxOrAbort(rec, reason + ':timeout');
      }
    }, 5000).unref();
  } else {
    cancelViaCtxOrAbort(rec, reason);
  }
  return true;
}

/**
 * 走 ctx.cancel() 优先（emit run.cancelled），ctx 缺失时退化到 abortController.abort()。
 * ctx.cancel() 幂等（context.js _cancelled flag），多次调用只触发一次 emit。
 */
function cancelViaCtxOrAbort(rec, reason) {
  try {
    if (rec.ctx && typeof rec.ctx.cancel === 'function') {
      rec.ctx.cancel(reason);
    } else {
      rec.abortController.abort(reason);
    }
  } catch { /* ignore */ }
}

/**
 * 仅供测试 / debug：列当前活跃 runId
 */
export function listActiveRuns() {
  return Array.from(activeRuns.keys());
}

// ──────────────────────────────────────────────────────────────────────────
// streamInput 模式（Phase 1.2，per-session long-running query）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 注册一个 long-running query session。session-loop.js runSession 启动时立即调，
 * query handle 在 attachSessionQuery 后填上。
 *
 * @param {string} sessionId
 * @param {object} deps
 * @param {AbortController} deps.abortController
 * @param {import('../../lib/async-queue.js').AsyncQueue} deps.inputQueue
 */
export function registerQuerySession(sessionId, { abortController, inputQueue } = {}) {
  if (!sessionId || !abortController || !inputQueue) return;
  activeQuerySessions.set(sessionId, {
    abortController,
    ctx: null,
    query: null,
    inputQueue,
    currentRunId: null,
    pendingQuestions: new Map(),
    pendingElicitations: new Map(),
    startedAt: Date.now(),
  });
}

/**
 * @param {string} sessionId
 * @param {import('@anthropic-ai/claude-agent-sdk').Query} query
 */
export function attachSessionQuery(sessionId, query) {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return;
  rec.query = query;
}

/**
 * @param {string} sessionId
 * @returns {ActiveQuerySession | undefined}
 */
export function getQuerySession(sessionId) {
  return activeQuerySessions.get(sessionId);
}

/**
 * @param {string} sessionId
 * @returns {boolean} true=session 已存在且 query 活着
 */
export function hasActiveQuerySession(sessionId) {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return false;
  if (rec.abortController.signal.aborted) return false;
  return true;
}

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
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return false;
  if (rec.abortController.signal.aborted) return false;
  // 把 runId 关联到 SDK message，runSession 那头收到 user message echo 时拿出来
  // 用作 currentTurn 标记。SDKUserMessage 没有自定义字段，我们走旁路：先在
  // session record 上设 currentRunId，runSession 收到 user message 时读这个值
  rec.currentRunId = runId;
  try {
    rec.inputQueue.push(sdkUserMessage);
    return true;
  } catch (err) {
    console.warn(`[active-runs] pushUserMessage failed for ${sessionId}: ${err.message}`);
    return false;
  }
}

/**
 * @param {string} sessionId
 * @returns {string|null}
 */
export function getCurrentTurnRunId(sessionId) {
  return activeQuerySessions.get(sessionId)?.currentRunId || null;
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
  const rec = activeQuerySessions.get(sessionId);
  return rec?.inputQueue?.size || 0;
}

/**
 * 直接设 currentRunId（不 push message）。给 turn.js 起新 runSession 时
 * 提前设第一 turn runId 用 —— pushUserMessage 在 register 之前没法调，
 * runSession 启动后用 initialRunId 参数把 currentRunId 提前填上。
 *
 * @param {string} sessionId
 * @param {string|null} runId
 */
export function setCurrentTurnRunId(sessionId, runId) {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return;
  rec.currentRunId = runId || null;
}

/**
 * 关闭 session 的 input queue → runSession 那头 for-await-of 自然结束 → query
 * 自动 unregister。
 *
 * 跟 cancelRun（per-turn interrupt）不同 —— close session 是终结整个 query，
 * 包括所有未处理消息，下次 turn 必须新建 session。
 *
 * @param {string} sessionId
 * @param {string} reason
 * @returns {boolean}
 */
export function closeQuerySession(sessionId, reason = 'user_close') {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return false;
  try { rec.inputQueue.close(); } catch { /* */ }
  try { rec.abortController.abort(reason); } catch { /* */ }
  return true;
}

/**
 * 注销 session — runSession 自然结束（inputQueue.close 后 for-await-of 退出）
 * 时 finally 里调。
 *
 * 顺手 reject 所有 pending questions / elicitations 防止外部 await 永久挂。
 *
 * @param {string} sessionId
 */
export function unregisterQuerySession(sessionId) {
  if (!sessionId) return;
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return;
  for (const [, p] of rec.pendingQuestions) {
    try { p.reject(new Error('session ended before user answered question')); } catch { /* */ }
  }
  rec.pendingQuestions.clear();
  for (const [, p] of rec.pendingElicitations) {
    try { p.reject(new Error('session ended before MCP elicitation answered')); } catch { /* */ }
  }
  rec.pendingElicitations.clear();
  activeQuerySessions.delete(sessionId);
}

/**
 * 仅供测试 / debug：列当前活跃 sessionId
 */
export function listActiveQuerySessions() {
  return Array.from(activeQuerySessions.keys());
}
