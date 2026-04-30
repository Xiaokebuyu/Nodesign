/**
 * AgentContext — 一次 run 的运行时上下文（SDK 包装版）
 *
 * 形态变更（2026-04-29 战略转向）：
 *   - 之前：自写 agent-loop + tool-registry，ctx 含 todoState / forTool() 给 tool execute 用
 *   - 现在：包 Claude Agent SDK 的 query()，工具由 SDK 内置 + 子进程跑，ctx 不再管 tool 执行
 *
 * 职责：
 *   - 串起 runId / skillId / EventBus / AbortController
 *   - 提供 workspace.* 包装供 skill loader / 业务逻辑读取沙盒
 *   - 暴露 emit() 把业务事件推到 EventBus（给 WS 桥接）
 *   - 跟踪 SDK 返回的 sessionId（从首条 message 提取，存 metadata）
 *   - 维护 counters（rounds / tokens / cost / errors）落 run.metadata
 *
 * 不再管：
 *   - todoState（SDK TodoWrite 工具自管）
 *   - forTool()（SDK 自己管 tool execute 上下文）
 */

import { promises as fs } from 'fs';
import path from 'path';
import { ensureWorkspace, getWorkspaceRoot, readFile, writeFile, listDir, exists, safeResolve } from '../runtime/workspace.js';
import { EventBus } from './events.js';

export class AgentContext {
  /**
   * @param {object} opts
   * @param {string} opts.runId
   * @param {string} opts.skillId
   * @param {EventBus} [opts.eventBus]
   * @param {AbortController} [opts.abortController]
   * @param {object} [opts.metadata={}]
   * @param {string} [opts.workspaceRoot]   - 外部 workspace（如 per-project 目录）；
   *                                          传了就走它，否则用 runId 推路径（旧 smoke 兼容）
   */
  constructor({ runId, skillId, eventBus, abortController, metadata = {}, workspaceRoot = null }) {
    if (!runId) throw new Error('AgentContext: runId required');
    if (!skillId) throw new Error('AgentContext: skillId required');

    this.runId = runId;
    this.skillId = skillId;
    this.eventBus = eventBus || new EventBus();
    this.abortController = abortController || new AbortController();
    this.metadata = metadata;
    this._externalWorkspaceRoot = workspaceRoot;

    // SDK 在 message 流里返回 session_id，首次见到时记下
    this.sdkSessionId = null;

    // 可观测计数器（落 run.metadata 用）
    this.counters = {
      turns: 0,                  // SDK num_turns
      toolCalls: 0,
      toolFailures: 0,
      compactBoundaries: 0,
      apiRetries: 0,
      durationMs: 0,
      durationApiMs: 0,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };

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

  // ── workspace 包装 ──
  // 外部 workspaceRoot 模式（P0 per-project 目录）：直接走绝对路径，
  // 由调用方负责 mkdir + git init（见 projects/workspace.js）。
  // 旧 runId 模式（保留给 smoke 测试 / 单 run 沙盒）：走 runtime/workspace.js 那套。

  workspace = {
    ensure: async () => {
      if (this._externalWorkspaceRoot) {
        await fs.mkdir(this._externalWorkspaceRoot, { recursive: true });
        return this._externalWorkspaceRoot;
      }
      return ensureWorkspace(this.runId);
    },
    root: () => this._externalWorkspaceRoot || getWorkspaceRoot(this.runId),
    exists: async (rel) => {
      if (this._externalWorkspaceRoot) {
        try {
          await fs.access(path.resolve(this._externalWorkspaceRoot, rel));
          return true;
        } catch {
          return false;
        }
      }
      return exists(this.runId, rel);
    },
    read: (rel) => readFile(this.runId, rel),
    write: (rel, content) => writeFile(this.runId, rel, content),
    list: (rel) => listDir(this.runId, rel),
    resolve: (rel) => safeResolve(this.runId, rel),
  };

  // ── 跟踪 SDK 数据 ──

  /** SDK 第一条 message 带 session_id，记下供 metadata / debug 用 */
  recordSdkSession(sessionId) {
    if (!this.sdkSessionId && sessionId) {
      this.sdkSessionId = sessionId;
      this.emit({ type: 'run.sdk.session', sessionId });
    }
  }

  /** SDK SDKResultMessage 含全套统计；一次性吸收 */
  absorbResult(result) {
    if (!result) return;
    this.counters.turns = result.num_turns ?? this.counters.turns;
    this.counters.durationMs = result.duration_ms ?? this.counters.durationMs;
    this.counters.durationApiMs = result.duration_api_ms ?? this.counters.durationApiMs;
    this.counters.totalCostUsd = result.total_cost_usd ?? this.counters.totalCostUsd;
    if (result.usage) {
      this.counters.inputTokens = result.usage.input_tokens || 0;
      this.counters.outputTokens = result.usage.output_tokens || 0;
      this.counters.cacheReadTokens = result.usage.cache_read_input_tokens || 0;
      this.counters.cacheCreateTokens = result.usage.cache_creation_input_tokens || 0;
    }
  }

  incrementTool(failed = false) {
    this.counters.toolCalls += 1;
    if (failed) this.counters.toolFailures += 1;
  }

  // ── observability ──

  snapshot() {
    return {
      runId: this.runId,
      skillId: this.skillId,
      sdkSessionId: this.sdkSessionId,
      counters: { ...this.counters },
      elapsedMs: Date.now() - this.startedAt,
      aborted: this.signal.aborted,
    };
  }
}
