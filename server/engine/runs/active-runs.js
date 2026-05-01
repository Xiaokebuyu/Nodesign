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
 * @typedef {object} ActiveRunRecord
 * @property {AbortController} abortController
 * @property {import('../agent/context.js').AgentContext} ctx  - AgentContext 引用，cancelRun 走 ctx.cancel() 统一 emit run.cancelled
 * @property {import('@anthropic-ai/claude-agent-sdk').Query|null} query  - query handle，先注册时为 null，attachQuery 后填
 * @property {number} startedAt
 */

/** @type {Map<string, ActiveRunRecord>} */
const activeRuns = new Map();

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
 */
export function unregisterRun(runId) {
  if (!runId) return;
  activeRuns.delete(runId);
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
  const rec = activeRuns.get(runId);
  if (!rec) return false;

  if (rec.query && typeof rec.query.interrupt === 'function') {
    // 优雅路径：query.interrupt() async + 5s 兜底
    rec.query.interrupt().catch((err) => {
      console.warn(`[active-runs] query.interrupt failed for ${runId}:`, err?.message);
      cancelViaCtxOrAbort(rec, reason);
    });

    // 5s 兜底：防止 SDK 自然结束流程卡住（如 reasoning 中、stream hang）
    setTimeout(() => {
      const stillActive = activeRuns.get(runId);
      if (stillActive && stillActive === rec) {
        cancelViaCtxOrAbort(rec, reason + ':timeout');
      }
    }, 5000).unref();
  } else {
    // race window：query 还没 attach（用户极快点停止）→ 直接 ctx.cancel()
    cancelViaCtxOrAbort(rec, reason);
  }

  // 不在这里 delete record。让 loop.js finally 的 unregisterRun 统一清理，
  // 避免 cancel 后 loop.js 还要查 record 时找不到。
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
