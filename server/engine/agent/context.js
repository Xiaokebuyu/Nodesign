/**
 * AgentContext — 一次 run 的运行时上下文
 *
 * 把 runId / workspace / 事件总线 / 取消信号 / 工具共享 state 包成一个对象，
 * 让 tools 和 agent loop 不必各自接一堆 props。
 *
 * 设计要点：
 *   - 一个 ctx 服务**一次** run，run 结束后丢弃
 *   - tools 通过 ctx.workspace.* 访问受沙盒约束的文件操作
 *   - tools 通过 ctx.todoState 共享 todo list（todo_write 工具读写）
 *   - tools 通过 ctx.signal 检查取消（长任务该 throw 'AbortError'）
 *   - 事件通过 ctx.emit(event) 推到 EventBus，外层（HTTP / WS）订阅消费
 *
 * 使用示例：
 *   const ctx = new AgentContext({ runId, skillId, eventBus });
 *   await ctx.ensureWorkspace();
 *   ctx.emit({ type: 'run.start' });
 *   await runAgentLoop({ executeTool: (name, input, opts) => {
 *     const tool = registry.get(name);
 *     return tool.execute(input, ctx.forTool(opts.signal));
 *   }, ... });
 */

import { ensureWorkspace, getWorkspaceRoot, readFile, writeFile, listDir, exists, safeResolve } from '../runtime/workspace.js';
import { EventBus } from './events.js';

export class AgentContext {
  /**
   * @param {object} opts
   * @param {string} opts.runId
   * @param {string} opts.skillId
   * @param {EventBus} [opts.eventBus]              - 不传则自建一个（单测/独立调用）
   * @param {AbortController} [opts.abortController] - 不传则自建
   * @param {object} [opts.metadata={}]              - 自由透传到事件 / 日志的元数据
   */
  constructor({ runId, skillId, eventBus, abortController, metadata = {} }) {
    if (!runId) throw new Error('AgentContext: runId required');
    if (!skillId) throw new Error('AgentContext: skillId required');

    this.runId = runId;
    this.skillId = skillId;
    this.eventBus = eventBus || new EventBus();
    this.abortController = abortController || new AbortController();
    this.metadata = metadata;

    // 工具共享状态（todo_write 落这里）
    this.todoState = [];

    // 一些可观测计数器（方便 metadata 落库）
    this.counters = {
      rounds: 0,
      toolCalls: 0,
      toolFailures: 0,
      textTokens: 0,
      thinkingTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };

    // 起始时间，给计算 elapsed 用
    this.startedAt = Date.now();
  }

  // ── 取消 ──

  get signal() {
    return this.abortController.signal;
  }

  cancel(reason = 'user_cancel') {
    this.abortController.abort(reason);
    this.emit({ type: 'run.cancelled', reason });
  }

  ensureNotAborted() {
    if (this.signal.aborted) {
      const err = new Error(`Run ${this.runId} aborted: ${this.signal.reason || 'unknown'}`);
      err.code = 'AGENT_ABORTED';
      throw err;
    }
  }

  // ── 事件 ──

  /**
   * 推一个事件到 EventBus。会自动补 runId / ts。
   * 调用方只需提供 type 和业务字段。
   */
  emit(event) {
    if (!event || !event.type) throw new Error('emit: event.type required');
    const enriched = {
      runId: this.runId,
      ts: new Date().toISOString(),
      ...event,
    };
    this.eventBus.publish(enriched);
    return enriched;
  }

  // ── workspace 包装（让 tools 不直接 import 模块路径）──

  workspace = {
    ensure: () => ensureWorkspace(this.runId),
    root: () => getWorkspaceRoot(this.runId),
    read: (rel) => readFile(this.runId, rel),
    write: (rel, content) => writeFile(this.runId, rel, content),
    list: (rel) => listDir(this.runId, rel),
    exists: (rel) => exists(this.runId, rel),
    resolve: (rel) => safeResolve(this.runId, rel),
  };

  /**
   * 给 tool.execute 用的轻量上下文（只暴露需要的能力）。
   * 第二个参数 signal 可选，调用方（agent-loop）会传入 per-tool signal
   * （含 timeout 派生的 AbortController）。
   */
  forTool(signal) {
    return {
      runId: this.runId,
      skillId: this.skillId,
      workspace: this.workspace,
      todoState: this.todoState,
      signal: signal || this.signal,
      emit: (event) => this.emit(event),
    };
  }

  // ── observability ──

  /** 返回当前可序列化的快照（给 metadata / debug 端点用） */
  snapshot() {
    return {
      runId: this.runId,
      skillId: this.skillId,
      counters: { ...this.counters },
      todoCount: this.todoState.length,
      elapsedMs: Date.now() - this.startedAt,
      aborted: this.signal.aborted,
    };
  }
}
