/**
 * server/engine/runs/active-runs.js — 活跃 run 的 AbortController registry
 *
 * 为什么需要：
 *   loop.js 的 ctx.abortController 是 in-memory 实例，外部（HTTP cancel
 *   endpoint）需要根据 runId 找到对应的 controller 才能 abort。
 *
 * 工作流：
 *   1. runAgent 启动时调 registerRun(runId, ctx.abortController)
 *   2. 用户点"停止"→ POST /api/projects/:pid/runs/:runId/cancel
 *      → cancelRun(runId) → controller.abort('user_cancel')
 *   3. SDK 看到 abort signal → query 中断 → loop.js try/catch 走 aborted
 *      路径 → emit run.cancelled
 *   4. runAgent finally 调 unregisterRun(runId)（无论成功失败）
 *
 * Map 是 in-memory：服务重启 controller 都没了（活跃 run 也都死了，
 * 一致）。多实例部署时需要分布式协调（stage 3 上 Redis pub/sub），但
 * stage 1 单进程够用。
 */

/** @type {Map<string, AbortController>} */
const activeControllers = new Map();

/**
 * 把当前活跃 run 的 controller 注册进 registry。
 * loop.js runAgent 启动时调一次。
 */
export function registerRun(runId, abortController) {
  if (!runId || !abortController) return;
  activeControllers.set(runId, abortController);
}

/**
 * 注销 run（无论 succeeded / failed / cancelled）。
 * loop.js runAgent finally 调，避免 controller 泄漏。
 */
export function unregisterRun(runId) {
  if (!runId) return;
  activeControllers.delete(runId);
}

/**
 * 取消活跃 run。
 *
 * @param {string} runId
 * @param {string} reason - 进 abort signal.reason，loop.js 走 cancelled 路径会读
 * @returns {boolean} true=成功 trigger abort；false=run 不在 registry（已结束 / 不存在）
 */
export function cancelRun(runId, reason = 'user_cancel') {
  const ctrl = activeControllers.get(runId);
  if (!ctrl) return false;
  try {
    ctrl.abort(reason);
  } catch {
    // AbortController.abort 一般不抛；防御性
  }
  activeControllers.delete(runId);
  return true;
}

/**
 * 仅供测试 / debug：列当前活跃 runId
 */
export function listActiveRuns() {
  return Array.from(activeControllers.keys());
}
