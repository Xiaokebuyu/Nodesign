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
import { repriceUsageDeltas } from './model-context.js';

/**
 * 一个回合的计数器初值。**唯一形状真相**：AgentContext 构造函数与 session-loop 的
 * startTurn（每个回合重置一次）都用它。
 *
 * ⛔ 08-21 夜血案：startTurn 里原来抄了一份字面量，08-21 深夜给构造函数加 `toolCharges`
 * 时没同步过去 → startTurn 必定跑在任何工具之前 → `addToolCharge` 读 undefined 直接
 * TypeError：generate_image 的 $0.20 一分没记，而且**成功出的图还会变成一次工具报错**。
 * 收成一份就没有下一次。
 */
export function freshTurnCounters() {
  return {
    turns: 0,                  // SDK num_turns
    toolCalls: 0,
    toolFailures: 0,
    compactBoundaries: 0,
    apiRetries: 0,
    firstTool: null,           // 本回合第一个工具名（AskUserQuestion = 先问；反问率统计用，落 run.metadata）
    durationMs: 0,
    durationApiMs: 0,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    modelUsage: null,   // 分模型本 turn 增量（absorbResult 差分产物）
    toolCharges: {},    // 按件计价的工具花费（generate_image $0.20/张），absorbResult 末尾并进 modelUsage
  };
}

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
   * @param {string} [opts.sessionId]       - 当前 SDK session id；emit 时自动 enrich 到事件，
   *                                          让 WS 端按 sid 过滤防跨 session 串扰
   * @param {string} [opts.appModel]        - NoDesign 上层真实 model（如 kimi-k2.6）。
   *                                          区别于 sdkOptions.model（spoofing alias，让 SDK
   *                                          内部 rawMaxTokens 算对）。hooks/events 算真实
   *                                          context window 时按 appModel 查映射表。
   */
  constructor({ runId, skillId, eventBus, abortController, metadata = {}, workspaceRoot = null, sessionId = null, appModel = null }) {
    if (!runId) throw new Error('AgentContext: runId required');
    if (!skillId) throw new Error('AgentContext: skillId required');

    this.runId = runId;
    this.skillId = skillId;
    this.sessionId = sessionId;
    this.appModel = appModel;
    this.eventBus = eventBus || new EventBus();
    this.abortController = abortController || new AbortController();
    this.metadata = metadata;
    this._externalWorkspaceRoot = workspaceRoot;

    // SDK 在 message 流里返回 session_id，首次见到时记下
    this.sdkSessionId = null;

    // result.modelUsage 的差分基准（2026-07-31）。modelUsage 是**会话累计值**
    // （探针实测：turn2 的值 = turn1 + turn2），要拿到本 turn 增量必须对上一条
    // result 做差。基准跟 ctx 同生命周期 = 跟 SDK query stream 同生命周期
    // （runSession 每次 new AgentContext + new stream），stream 重启累计值归零、
    // 基准也归零，差分天然对齐。**不随 turn 边界重置**。
    this._modelUsageBase = null;

    // 可观测计数器（落 run.metadata 用）—— 形状只有 freshTurnCounters 一份
    this.counters = freshTurnCounters();

    this.startedAt = Date.now();
  }

  // ── 取消 ──

  get signal() {
    return this.abortController.signal;
  }

  /**
   * 取消 run。Phase 3c 加幂等保证 —— cancel 多次只触发一次 abort + 一次
   * run.cancelled emit。两条调用路径都依赖此幂等：
   *   1. cancelRun（active-runs.js）race window / interrupt 兜底时直接调
   *   2. session-loop.js result 处理识别 terminal_reason: 'aborted_*' 时调（interrupt 路径）
   *
   * 没有这个 flag，interrupt 路径 + abort 兜底会双 emit run.cancelled，
   * 前端 toast '已取消' 弹两次。
   */
  cancel(reason = 'user_cancel') {
    if (this._cancelled) return;
    this._cancelled = true;
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
    // sessionId 自动 enrich 让 WS 端按 sid 过滤事件，防多 session / 多 tab 跨 session
    // 串扰（同 project bus 共享）。`...event` 在后保证调用方显式传的字段不被覆盖。
    const enriched = {
      runId: this.runId,
      sessionId: this.sessionId,
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

  /**
   * SDK SDKResultMessage 含全套统计；一次性吸收。
   *
   * 计量口径（2026-07-31 起）：权威数据源是 result.modelUsage —— SDK 的分模型
   * 总账，含子代理消耗，中断的 turn 也不丢（累计值持续增长，下一条 result 的
   * 差分会捞回来）。差分出的本 turn 增量：
   *   - 按模型汇总进 counters.inputTokens 等主字段（配额真列的来源）
   *   - 分模型明细留在 counters.modelUsage，finishTurn 落 run_model_usage 表
   *   - totalCostUsd 同样取差分（result.total_cost_usd 是会话累计值，以前
   *     原样落库导致 cost 列不能 sum —— 那是虚价，但至少语义要对）
   * result.usage 只做 modelUsage 缺失时的兜底（usage 是本轮真增量，探针实测）。
   */
  absorbResult(result) {
    if (!result) return;
    this.counters.turns = result.num_turns ?? this.counters.turns;
    this.counters.durationMs = result.duration_ms ?? this.counters.durationMs;
    this.counters.durationApiMs = result.duration_api_ms ?? this.counters.durationApiMs;

    // reprice：仅 API 会话 —— key 从 SDK spoof alias 还原成 appModel、按表价
    // 重算 costUsd（SDK 按 alias 的 Claude 价目表算，Kimi 时代虚高 30×）。
    // 订阅会话原样过（alias 与真订阅模型名同形，必须以会话通路为准，见
    // model-context.js repriceUsageDeltas 注释）。
    const deltas = repriceUsageDeltas(this._diffModelUsage(result.modelUsage), this.appModel);
    if (deltas) {
      let inp = 0; let out = 0; let cr = 0; let cc = 0; let cost = 0;
      for (const d of Object.values(deltas)) {
        inp += d.inputTokens; out += d.outputTokens;
        cr += d.cacheReadTokens; cc += d.cacheCreateTokens;
        cost += d.costUsd;
      }
      this.counters.inputTokens = inp;
      this.counters.outputTokens = out;
      this.counters.cacheReadTokens = cr;
      this.counters.cacheCreateTokens = cc;
      this.counters.totalCostUsd = cost;
      this.counters.modelUsage = deltas;
    } else if (result.usage) {
      this.counters.inputTokens = result.usage.input_tokens || 0;
      this.counters.outputTokens = result.usage.output_tokens || 0;
      this.counters.cacheReadTokens = result.usage.cache_read_input_tokens || 0;
      this.counters.cacheCreateTokens = result.usage.cache_creation_input_tokens || 0;
      this.counters.totalCostUsd = result.total_cost_usd ?? this.counters.totalCostUsd;
    }
    this._foldToolCharges();
  }

  /**
   * 半截续接的账要**结转**（08-21 夜，fable 评审 P0）。
   *
   * 病：absorbResult 对 counters 是**赋值不是累加**（差分基准 _modelUsageBase 在第一个
   * result 就前移了），而半截续接会让同一个 run 出现第二个 result → 第一轮的整份账
   * （token、表价 cost、已经折进去的 generate_image 按件费、上游自报的真 cost）被第二轮
   * 的增量整个覆盖 → 那一轮等于白跑，日限闸门（quota.usedCostToday 读 run_model_usage）少收。
   * 真路径实测：续接的回合上游真打 2 发、落库只有 1 发的量。
   *
   * 用法：推续接消息**之前** takeCarry() 存一份，下一个 result 的 absorbResult /
   * applyUpstreamBilling 跑完后 addCarry(carry) 加回去。多次续接会一路滚下去。
   *
   * ⚠️ 只加"可累加"的量：token / cost / 时长 / 工具计数。`turns` 不加 —— 它是 SDK 的
   * num_turns，本身带累计语义，加了会双数。
   */
  takeCarry() {
    const c = this.counters;
    return {
      inputTokens: c.inputTokens || 0,
      outputTokens: c.outputTokens || 0,
      cacheReadTokens: c.cacheReadTokens || 0,
      cacheCreateTokens: c.cacheCreateTokens || 0,
      totalCostUsd: c.totalCostUsd || 0,
      durationMs: c.durationMs || 0,
      durationApiMs: c.durationApiMs || 0,
      toolCalls: c.toolCalls || 0,
      toolFailures: c.toolFailures || 0,
      compactBoundaries: c.compactBoundaries || 0,
      apiRetries: c.apiRetries || 0,
      firstTool: c.firstTool || null,
      modelUsage: c.modelUsage ? JSON.parse(JSON.stringify(c.modelUsage)) : null,
    };
  }

  addCarry(carry) {
    if (!carry) return;
    const c = this.counters;
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'totalCostUsd', 'durationMs', 'durationApiMs']) {
      c[k] = (c[k] || 0) + (carry[k] || 0);
    }
    // toolCalls 等计数器**不是**每回合重置后单调累加的差分量，而是 handleSDKMessage 一路 ++ 的，
    // 续接期间它们没被重置（同一个 run 同一个 ctx）→ 已经含了第一轮，别再加一遍。
    if (carry.modelUsage) {
      const usage = c.modelUsage && typeof c.modelUsage === 'object' ? c.modelUsage : {};
      for (const [name, d] of Object.entries(carry.modelUsage)) {
        const prev = usage[name] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 };
        usage[name] = {
          ...prev,
          inputTokens: (prev.inputTokens || 0) + (d.inputTokens || 0),
          outputTokens: (prev.outputTokens || 0) + (d.outputTokens || 0),
          cacheReadTokens: (prev.cacheReadTokens || 0) + (d.cacheReadTokens || 0),
          cacheCreateTokens: (prev.cacheCreateTokens || 0) + (d.cacheCreateTokens || 0),
          costUsd: (prev.costUsd || 0) + (d.costUsd || 0),
        };
      }
      c.modelUsage = usage;
    }
  }

  /** 按件计价的工具花费（generate_image 每张 $0.20）：工具成功后记一笔，结账时并进 modelUsage 同一本账 */
  addToolCharge(name, usd) {
    const v = Number(usd);
    if (!name || !Number.isFinite(v) || v <= 0) return;
    this.counters.toolCharges[name] = (this.counters.toolCharges[name] || 0) + v;
  }
  _foldToolCharges() {
    const charges = this.counters.toolCharges || {};
    const names = Object.keys(charges);
    if (!names.length) return;
    const usage = this.counters.modelUsage && typeof this.counters.modelUsage === 'object' ? this.counters.modelUsage : {};
    for (const name of names) {
      const prev = usage[name] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 };
      usage[name] = { ...prev, costUsd: (prev.costUsd || 0) + charges[name] };
    }
    this.counters.modelUsage = usage;
    this.counters.totalCostUsd = Object.values(usage).reduce((s, d) => s + (d.costUsd || 0), 0);
    this.counters.toolCharges = {};
  }

  /**
   * 上游自报的费用覆盖（08-21 晚，lib/ingress/upstream-billing.js）。
   * billing = { appModel → { costUsd, responses, promptTokens, completionTokens, cachedTokens } }，
   * 是 ingress 在本轮累加、session-loop 结账前取走的。规则：
   *   - 上游报的 cost **> 0**（真扣了余额）→ 覆盖 modelUsage[appModel].costUsd；token 数仍信 SDK 差分（口径不同）
   *   - 上游报 0 / 没报 → 保留表价算出来的数。OpenCode Go 订阅行（08-21 深夜实测）对订阅额度内的请求报 cost=0，
   *     但它消耗的是全站共享的 Go 池子（$12/5h），按表价记才能让每用户日限跟着受控；免费行表价本就是 0
   *   - SDK 没有该模型条目（CLI 失败 / 没覆盖到的 helper）→ 用上游 token 数补一条，按表价算（repriceUsageDeltas）
   * 覆盖后重算 totalCostUsd。counters.costSource：'upstream'（上游真扣费覆盖过）| 'table'（只按表价）
   */
  applyUpstreamBilling(billing) {
    if (!billing || typeof billing !== 'object') return;
    let touched = false; let overrode = false;
    const usage = this.counters.modelUsage && typeof this.counters.modelUsage === 'object' ? this.counters.modelUsage : {};
    for (const [appModel, acc] of Object.entries(billing)) {
      if (!acc || !acc.responses) continue;
      const reported = acc.costUsd != null && Number(acc.costUsd) > 0 ? Number(acc.costUsd) : null;
      const prev = usage[appModel];
      if (prev) {
        if (reported != null) { usage[appModel] = { ...prev, costUsd: reported }; overrode = true; touched = true; }
        continue;
      }
      // SDK 没这条（CLI 失败那类）：用上游 token 数补一条，先按表价，再看上游有没有真扣费
      const cached = acc.cachedTokens || 0;
      const raw = { [appModel]: { inputTokens: Math.max(0, (acc.promptTokens || 0) - cached), outputTokens: acc.completionTokens || 0, cacheReadTokens: cached, cacheCreateTokens: 0, costUsd: 0 } };
      const priced = repriceUsageDeltas(raw, this.appModel)?.[appModel] || raw[appModel];
      usage[appModel] = reported != null ? { ...priced, costUsd: reported } : priced;
      if (reported != null) overrode = true;
      touched = true;
    }
    if (!touched) return;
    this.counters.modelUsage = usage;
    this.counters.totalCostUsd = Object.values(usage).reduce((s, d) => s + (d.costUsd || 0), 0);
    this.counters.costSource = overrode ? 'upstream' : 'table';
  }

  /**
   * 会话累计的 modelUsage → 本 turn 增量。返回 null 表示"没有可用的 modelUsage"
   * （调用方退回 usage 兜底）；返回 {}（空对象）表示"有 modelUsage 但本 turn
   * 没有任何新消耗"，此时主字段照常清零是正确语义。
   * Math.max(0, ...) 防浮点 / 上游异常出负数；基准无论如何都更新成最新快照。
   */
  _diffModelUsage(modelUsage) {
    if (!modelUsage || typeof modelUsage !== 'object') return null;
    const models = Object.keys(modelUsage);
    if (models.length === 0) return null;
    const base = this._modelUsageBase || {};
    const deltas = {};
    const snapshot = {};
    for (const model of models) {
      const u = modelUsage[model] || {};
      const b = base[model] || {};
      snapshot[model] = {
        inputTokens: u.inputTokens || 0,
        outputTokens: u.outputTokens || 0,
        cacheReadInputTokens: u.cacheReadInputTokens || 0,
        cacheCreationInputTokens: u.cacheCreationInputTokens || 0,
        costUSD: u.costUSD || 0,
      };
      const d = {
        inputTokens: Math.max(0, snapshot[model].inputTokens - (b.inputTokens || 0)),
        outputTokens: Math.max(0, snapshot[model].outputTokens - (b.outputTokens || 0)),
        cacheReadTokens: Math.max(0, snapshot[model].cacheReadInputTokens - (b.cacheReadInputTokens || 0)),
        cacheCreateTokens: Math.max(0, snapshot[model].cacheCreationInputTokens - (b.cacheCreationInputTokens || 0)),
        costUsd: Math.max(0, snapshot[model].costUSD - (b.costUSD || 0)),
      };
      if (d.inputTokens || d.outputTokens || d.cacheReadTokens || d.cacheCreateTokens || d.costUsd) {
        deltas[model] = d;
      }
    }
    // 基准里已有但本次 modelUsage 没出现的模型：保留旧值（SDK 不应该丢 key，
    // 防御性合并，免得它真丢时差分把历史消耗又算一遍）
    this._modelUsageBase = { ...base, ...snapshot };
    return deltas;
  }

  incrementTool(failed = false) {
    this.counters.toolCalls += 1;
    if (failed) this.counters.toolFailures += 1;
  }

  /**
   * 子代理收尾用量（SDK task_notification.usage）累积（2026-07-30）。
   * **单独记账，不加进主 inputTokens/outputTokens** —— 主字段现在来自
   * modelUsage 差分（SDK 的分模型总账，已含 sidechain），相加必然双重计数。
   * 这两个字段只进 metadata 做可观测（"这轮子代理烧了多少"），也是交叉验证
   * 钩子：某轮 subagent 用量明显大于 modelUsage 差分总和 = 总账没含 sidechain
   * 的信号（目前判断是含的，出现反例再查）。
   */
  absorbSubagentUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    this.counters.subagentInputTokens = (this.counters.subagentInputTokens || 0) + (usage.input_tokens || 0);
    this.counters.subagentOutputTokens = (this.counters.subagentOutputTokens || 0) + (usage.output_tokens || 0);
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
