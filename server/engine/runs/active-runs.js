/**
 * server/engine/runs/active-runs.js — 活跃 run registry
 *
 * 为什么需要：
 *   session-loop.js 的 ctx.abortController / ctx 是 in-memory 实例，外部（HTTP cancel
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
 *      → session-loop.js 走 cancelled 路径或 catch
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
 *      （sdk.d.ts:2018-2022）。session-loop.js 已统一把所有 prompt 包成
 *      AsyncIterable<SDKUserMessage>，符合此前提。
 *
 * Map 是 in-memory：服务重启 controller / ctx 都没了（活跃 run 也都死了，一致）。
 * 多实例部署时需要分布式协调（Redis pub/sub），stage 1 单进程够用。
 */

import { markRunFailed } from './store.js';

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
 * @property {string} currentPermissionMode  - 当前 SDK permissionMode（'auto' | 'bypassPermissions' 等）
 *   canUseTool 钩子按此分流（auto 模式升级口）。
 *   初值来自 registerQuerySession 的 initialPermissionMode；运行时切 mode（query.
 *   setPermissionMode）必须同步调 setSessionPermissionMode 更新本字段，否则 canUseTool
 *   仍按旧 mode 拦截。
 * @property {number} startedAt
 * @property {number} lastActivityAt - 最近一次"活跃信号"时间戳（push message / turn 边界 /
 *   WS subscriber 连上）。session-loop.js 的 idle scan 据此判断是否超时关闭。
 * @property {symbol} _token - register 时分配的唯一身份 token。closeQuerySession
 *   立即 unregister 让出 sid 后，session-loop.js finally 的 unregister 调用必须带
 *   token 比对——若 sid 已被新 register 占用，token 不匹配 → noop 防误删新 entry。
 */

/** @type {Map<string, ActiveQuerySession>} */
const activeQuerySessions = new Map();

/**
 * 注册 run。runAgent 启动后立即调（query 还没拿到 handle）。
 * 后续在 session-loop.js 拿到 query handle 后调 attachQuery 把 query 填上。
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
 * session-loop.js 在 `const stream = query({ ... })` 之后立即调。
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
 * session-loop.js runAgent finally 调，避免引用泄漏。
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
 * session-loop.js canUseTool 拦到 AskUserQuestion 时调，emit 事件后 await 返回的
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
 * session-loop.js onElicitation 回调拦到 MCP server elicit 请求时调，emit 事件后 await
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
 * 快捷方法：从 runId 拿 query handle —— streamInput 模式下走 sessionId 反查。
 *
 * ⚠️ 历史包袱：activeRuns 的 rec.query 字段在 streamInput 模式下**永远是 null**
 * （session-loop.js 只调 attachSessionQuery 不调 attachQuery，因为 query handle
 * 是 per-session 不是 per-run 的）。直接读 activeRuns.get(runId)?.query 永远拿
 * 不到 → turn.js plan-approve / plan-reject / rewindFiles / setModel 4 个
 * endpoint 历史上**全部 broken**，用户体验是 "run not active"（虽然 run 真在跑）。
 *
 * 本函数现在反查：runId → sessionId → activeQuerySessions[sid].query。
 * 兼容老路径：若 activeRuns.get(runId)?.query 真有值（比如非 streamInput 路径
 * 留下的），优先返它。
 *
 * @returns {import('@anthropic-ai/claude-agent-sdk').Query | null | undefined}
 */
export function getQuery(runId) {
  if (!runId) return null;
  // 老路径（非 streamInput / 测试 stub）
  const runRec = activeRuns.get(runId);
  if (runRec?.query) return runRec.query;
  // streamInput 路径：runId → sessionId → query
  for (const [, rec] of activeQuerySessions) {
    if (rec.currentRunId === runId) return rec.query;
  }
  return null;
}

/**
 * 取消活跃 run。
 *
 * Phase 3c 升级：
 *   优先 query.interrupt() 优雅中断 —— agent 能写完当前 token 块再停。
 *   SDK 收到 interrupt 后 query 自然结束，推 SDKResultMessage 含
 *   terminal_reason: 'aborted_streaming' | 'aborted_tools'（sdk.d.ts:5339），
 *   session-loop.js result 处理识别后调 ctx.cancel() emit run.cancelled。
 *
 *   5s 兜底 ctx.cancel()：interrupt 后 SDK 偶尔会卡住（reasoning 进行中），
 *   timeout 兜底强制 abort + emit run.cancelled，前端不会卡 streaming。
 *
 * 三条路径全部走 ctx.cancel()（幂等）保证 run.cancelled 恰好 emit 一次：
 *   a. interrupt 成功 → session-loop.js result 路径调 ctx.cancel()
 *   b. interrupt 失败兜底 → cancelRun 直接调 ctx.cancel()
 *   c. race window（query 还没 attach）→ cancelRun 直接调 ctx.cancel()
 *
 * @param {string} runId
 * @param {string} reason - 写入 abort signal.reason，session-loop.js cancelled 路径会读
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
        // 停止路径补落终态（08-30 挂账，09-08 修）：interrupt 成功≠回合结束 —— SDK 在 API 重试 / 首包之前被打断时
        // 不会吐 result，runs 行停在 running、前端等不到 run.cancelled（activeRun 卡住，桌面版共视的遮罩也就卡住）。
        // 给它 8 秒：还是这一轮在飞就关整个 session，runSession 的收尾路径会 finishTurn('cancelled')，行落终态、事件照发。
        const timer = setTimeout(() => {
          const still = activeQuerySessions.get(sid);
          if (still && still.currentRunId === runId && !still.abortController.signal.aborted) {
            console.warn(`[active-runs] run ${runId} still running 8s after interrupt → closing session ${sid.slice(0, 8)} to settle it`);
            closeQuerySession(sid, reason + ':interrupt_timeout');
          }
        }, 8000);
        timer.unref?.();
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
 * @param {string} [deps.initialPermissionMode='bypassPermissions']  - 初始 permission mode
 * @returns {symbol|false} 注册成功返 token（Symbol，唯一身份）；同 sid 已活跃返 false。
 *   caller 必须保留 token 在 unregister 时回传，让 active-runs 比对身份后再删，
 *   防止"closeQuerySession 已让位 + 新 session register 后，旧 session-loop finally
 *   误删新 entry"的 race（grace timer 关 session 后用户立即重发的真实场景）。
 */
export function registerQuerySession(sessionId, { abortController, inputQueue, initialPermissionMode = 'bypassPermissions' } = {}) {
  if (!sessionId || !abortController || !inputQueue) return false;
  // 关键去重：同 sid 已注册就拒绝（旧 record .set 覆盖会让旧 abortController + inputQueue
  // 失去引用，旧 SDK binary 仍在跑变孤儿 → 跟新 binary 并行 Write 同 canvas.html
  // = 用户看到"独立 main 进程在 write"的 bug 来源）。caller 拿到 false 不再 spawn
  // 第二个 query。前端 race / 后端 fallback / resume race 都靠这条兜底。
  const existing = activeQuerySessions.get(sessionId);
  if (existing) {
    // aborted 但没被清的残留 entry（abort 路径绕过了 unregister）—— 清掉重注册。
    // 老逻辑对这种残留一律拒绝，跟 turn.js 的 hasActiveQuerySession（aborted 返
    // false）判定不一致：窗口内用户消息 push 进无人消费的新 queue = 静默黑洞。
    if (existing.abortController.signal.aborted) {
      console.warn(`[active-runs] registerQuerySession: sid=${sessionId.slice(0, 8)} had stale aborted entry, cleaning up before re-register`);
      unregisterQuerySession(sessionId);
    } else {
      console.warn(
        `[active-runs] registerQuerySession: sid=${sessionId.slice(0, 8)} already active, `
        + `refusing duplicate registration (would orphan existing SDK binary + cause double-write race)`
      );
      return false;
    }
  }
  const token = Symbol('querySession');
  activeQuerySessions.set(sessionId, {
    abortController,
    query: null,
    inputQueue,
    currentRunId: null,
    pendingRunIds: [],
    // uuid → runId：pushUserMessage 盖在出站 SDKUserMessage 上的章。CLI 开着
    // --replay-user-messages 时会把这条消息原样回显（带同一个 uuid），回显的
    // 时刻 = 它真正被并进对话的时刻 —— 那才是 turn 边界的锚（见 claimRunByUuid）。
    runIdByUuid: new Map(),
    pendingQuestions: new Map(),
    pendingElicitations: new Map(),
    currentPermissionMode: initialPermissionMode,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    _token: token,
  });
  return token;
}

/**
 * 标记 session 活跃（更新 lastActivityAt）。每个有意义的"用户/系统在用这个 session"
 * 信号都该调：pushUserMessage / turn 边界 / WS subscriber 连上 / WS 收 hydrate 请求等。
 *
 * idle timeout 扫描（session-loop.js）按此字段判断 now - lastActivityAt > IDLE_TIMEOUT
 * 时关 session。
 *
 * @param {string} sessionId
 */
export function markSessionActivity(sessionId) {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return;
  rec.lastActivityAt = Date.now();
}

/**
 * @param {string} sessionId
 * @returns {number|null} lastActivityAt 时间戳；session 不存在时 null
 */
export function getSessionLastActivity(sessionId) {
  const rec = activeQuerySessions.get(sessionId);
  return rec?.lastActivityAt ?? null;
}

/**
 * 同步更新 session 当前 permissionMode（canUseTool 钩子按此分流）。
 * 必在 query.setPermissionMode(mode) 成功后调，否则 canUseTool 仍按旧 mode 拦截。
 *
 * @param {string} sessionId
 * @param {string} mode  - 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
 */
export function setSessionPermissionMode(sessionId, mode) {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return;
  rec.currentPermissionMode = mode;
}

/**
 * @param {string} sessionId
 * @returns {string|null}
 */
export function getSessionPermissionMode(sessionId) {
  const rec = activeQuerySessions.get(sessionId);
  return rec?.currentPermissionMode || null;
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
/** 诊断用：全部在册的 query 会话（不含 abort 了没清的残留标记 aborted:true 也照列） */
export function listQuerySessions() {
  return [...activeQuerySessions].map(([sessionId, rec]) => ({
    sessionId, aborted: !!rec.abortController?.signal?.aborted, permissionMode: rec.currentPermissionMode ?? null, startedAt: rec.startedAt ? new Date(rec.startedAt).toISOString() : null, pendingRuns: rec.pendingRunIds?.length ?? 0,
    currentRunId: rec.currentRunId || null, lastActivity: rec.lastActivityAt ? new Date(rec.lastActivityAt).toISOString() : null, hasQuery: !!rec.query,
  }));
}

export function hasActiveQuerySession(sessionId) {
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return false;
  if (rec.abortController.signal.aborted) return false;
  return true;
}

/**
 * @param {string} sessionId
 * @returns {string|null}
 */
export function getCurrentTurnRunId(sessionId) {
  return activeQuerySessions.get(sessionId)?.currentRunId || null;
}

/**
 * 反向查找：给定 runId 找到所属 sessionId（streamInput 模式 run/session 多对一）。
 * 用于 turn.js /permission-mode endpoint：endpoint 拿到 runId 但要更新 session 级
 * 的 permission mode（canUseTool 按 session 查）。
 *
 * @param {string} runId
 * @returns {string|null}
 */
export function getSessionIdByRunId(runId) {
  if (!runId) return null;
  for (const [sid, rec] of activeQuerySessions) {
    if (rec.currentRunId === runId) return sid;
  }
  return null;
}

/**
 * 并发闸门数据源（2026-07-30 内测）：此刻真正在跑的 turn 数。
 * activeQuerySessions 里 currentRunId 非空 = 该 session 有 turn 在飞。
 * idle 的活跃 session（query 开着等消息）不算并发。
 */
export function countRunningTurns() {
  let n = 0;
  for (const rec of activeQuerySessions.values()) {
    if (rec.currentRunId) n += 1;
  }
  return n;
}

/** 此刻正在跑的 turn 的 runId 列表（配额层按 runs.user_id 归属到用户） */
export function listRunningTurnRunIds() {
  const ids = [];
  for (const rec of activeQuerySessions.values()) {
    if (rec.currentRunId) ids.push(rec.currentRunId);
  }
  return ids;
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
 * 退出后 finally 调 unregisterQuerySession（带 token 比对）。
 *
 * 跟 cancelRun（per-turn interrupt）不同 —— close session 是终结整个 query，
 * 包括所有未处理消息，下次 turn 必须新建 session。
 *
 * 关键：**立即 unregister 让出 sid**（同步 delete entry + 清 pending），让用户在 SDK
 * subprocess 完整退出之前重发新 chat 时，registerQuerySession 不被"同 sid 已活跃"
 * 拒绝（grace timer 关 session 后用户立即重连重发的真实生产 race）。session-loop
 * 的 finally 仍会 unregister，但带 token 比对——若 sid 已被新 register 占用，
 * 旧 token 不匹配 → noop 不误删新 entry。
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
  // 同步 unregister：立刻让出 sid。abort() 已触发 pending 的 onAbort listener
  // reject Promise；这里再清一次（pending Maps clear + delete entry）双保险幂等。
  unregisterQuerySession(sessionId);
  return true;
}

/**
 * 注销 session — runSession 自然结束（inputQueue.close 后 for-await-of 退出）
 * 时 finally 里调，或 closeQuerySession 同步调。
 *
 * 顺手 reject 所有 pending questions / elicitations 防止外部 await 永久挂。
 *
 * @param {string} sessionId
 * @param {symbol} [expectedToken] - 可选身份 token（registerQuerySession 返回的）。
 *   传了就比对：rec._token !== token → noop（说明 sid 已被新 register 占用，
 *   不是我的 entry，不能动）。closeQuerySession 路径不传，无条件清当前 entry。
 */
export function unregisterQuerySession(sessionId, expectedToken = null) {
  if (!sessionId) return;
  const rec = activeQuerySessions.get(sessionId);
  if (!rec) return;
  // 身份比对：sid 已被新 register 占用时，旧 caller 不能误删新 entry
  if (expectedToken != null && rec._token !== expectedToken) return;
  for (const [, p] of rec.pendingQuestions) {
    try { p.reject(new Error('session ended before user answered question')); } catch { /* */ }
  }
  rec.pendingQuestions.clear();
  for (const [, p] of rec.pendingElicitations) {
    try { p.reject(new Error('session ended before MCP elicitation answered')); } catch { /* */ }
  }
  rec.pendingElicitations.clear();
  // 排队中还没跑到的 turn：run 行不能永远停 pending，标 failed 让前端/审计有终态
  for (const rid of (rec.pendingRunIds || [])) {
    try { markRunFailed(rid, 'session ended before queued turn started'); } catch { /* */ }
  }
  if (rec.pendingRunIds) rec.pendingRunIds.length = 0;
  rec.runIdByUuid?.clear?.();
  activeQuerySessions.delete(sessionId);
}

/**
 * 仅供测试 / debug：列当前活跃 sessionId
 */
export function listActiveQuerySessions() {
  return Array.from(activeQuerySessions.keys());
}
