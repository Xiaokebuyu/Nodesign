/**
 * server/engine/runs/active-runs.js — 活跃 run registry
 *
 * 为什么需要：
 *   loop.js 的 ctx.abortController 是 in-memory 实例，外部（HTTP cancel
 *   endpoint）需要根据 runId 找到对应的 controller / query handle 才能控制。
 *
 * 工作流：
 *   1. runAgent 启动时立即 registerRun(runId, { abortController })
 *      —— 此时 query 还没调，先注册 controller 让 cancel race condition 兜底
 *   2. query() 拿到 handle 后调 attachQuery(runId, query)
 *      —— 之后所有 control 方法（interrupt/setModel/rewindFiles/...）可用
 *   3. 用户点"停止"→ POST /api/projects/:pid/runs/:runId/cancel
 *      → cancelRun(runId) → 优先 query.interrupt()（优雅，agent 能写完一句再停）
 *      → fallback abortController.abort()（硬断）
 *   4. SDK 看到 interrupt/abort → query 中断 → loop.js 走 cancelled 路径
 *      → emit run.cancelled
 *   5. runAgent finally 调 unregisterRun(runId)（无论成功失败）
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
 * Map 是 in-memory：服务重启 controller 都没了（活跃 run 也都死了，一致）。
 * 多实例部署时需要分布式协调（Redis pub/sub），stage 1 单进程够用。
 */

/**
 * @typedef {object} ActiveRunRecord
 * @property {AbortController} abortController
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
 * @param {{ abortController: AbortController }} deps
 */
export function registerRun(runId, { abortController } = {}) {
  if (!runId || !abortController) return;
  activeRuns.set(runId, {
    abortController,
    query: null,
    startedAt: Date.now(),
  });
}

/**
 * 把 query handle attach 到已注册的 run。
 * loop.js 在 `const stream = query({ ... })` 之后立即调。
 *
 * 之所以分两步注册：query() 调用之前 cancel race（用户极快点停止）能拿到
 * abortController 兜底；query() 之后 cancel 走 query.interrupt() 优雅路径。
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
 * loop.js runAgent finally 调，避免 controller / query 引用泄漏。
 */
export function unregisterRun(runId) {
  if (!runId) return;
  activeRuns.delete(runId);
}

/**
 * 取回完整 record（abortController + query handle + startedAt）。
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
 * Phase 1 实现：走 abortController.abort(reason) 硬断路径。
 * loop.js try/catch 检测 ctx.signal.aborted=true → 走 cancelled 路径 → emit run.cancelled。
 * 前端 Project.jsx case 'run.cancelled' 显示 toast '已取消'。
 *
 * **为什么不先调 query.interrupt()**：
 *   query.interrupt() 让 SDK 自然结束 query loop（terminal_reason: 'aborted_streaming' /
 *   'aborted_tools'，sdk.d.ts:5339）。但当前 loop.js 把 SDKResultMessage.subtype === 'success'
 *   的结果都当成功处理（[loop.js 280-294]），结果会 emit run.done（带不完整 finalText）
 *   而不是 run.cancelled —— 前端 toast '已取消' 失效。
 *
 *   切换到 interrupt-优先路径需要 loop.js 一起改：识别 terminal_reason: 'aborted_*'
 *   走 cancelled 而非 success 路径。这超 Phase 1（active-runs 升级）范围，
 *   留给后续 phase 一起做。query handle 仍然 attach 进 registry，给上层用作其他
 *   control 方法（rewindFiles / setModel / getContextUsage / ...）。
 *
 * @param {string} runId
 * @param {string} reason - 写入 abort signal.reason，loop.js cancelled 路径会读
 * @returns {boolean} true=成功 trigger；false=run 不在 registry（已结束 / 不存在）
 */
export function cancelRun(runId, reason = 'user_cancel') {
  const rec = activeRuns.get(runId);
  if (!rec) return false;
  try {
    rec.abortController.abort(reason);
  } catch {
    // AbortController.abort 一般不抛；防御性
  }
  // 注意：不在这里 delete record。让 loop.js finally 的 unregisterRun 统一清理，
  // 避免 abort 后 loop.js 还要查 record 时找不到。
  return true;
}

/**
 * 仅供测试 / debug：列当前活跃 runId
 */
export function listActiveRuns() {
  return Array.from(activeRuns.keys());
}
