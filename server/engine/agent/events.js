/**
 * EventBus — agent 事件总线（标准化事件 schema）
 *
 * 设计：
 *   - 极简 EventEmitter（基于 Set<listener>），不依赖 node:events 避免 max listener warn
 *   - 每条事件至少含 { type, runId, ts }
 *   - 监听器订阅时可选择全订（'*'）或按前缀（'run.delta'）或按 type 精确匹配
 *
 * 标准事件 schema（type）：
 *   ── 主流程 ──
 *   run.start                  开始
 *   run.round.start            { round }
 *   run.round.end              { round, stopReason, usage? }
 *   run.delta.text             { round, text }
 *   run.delta.thinking         { round, text }
 *   run.delta.tool_use         { round, blockId, name, input }
 *   run.delta.tool_result      { round, blockId, name, ok, output?, error? }
 *   run.todo.updated           { todos }
 *   run.cancelled              { reason }
 *   run.done                   { finalText, artifactPath?, snapshot }
 *   run.error                  { message, code?, stack? }
 *
 *   ── P0+ stage 1 新增（SDK 28+ 种 message 类型映射）──
 *   run.tool_progress          { blockId, toolName, elapsedSeconds }      工具执行中（>1s 才发）
 *   run.prompt_suggestion      { suggestion }                              每轮后预测下条 prompt
 *   run.task.started           { taskId, description, taskType }           subagent 启动
 *   run.task.progress          { taskId, description, summary?, lastToolName? }  subagent 30s 摘要（agentProgressSummaries）
 *   run.task.updated           { taskId, patch }                           subagent 状态 patch
 *   run.task.notification      { taskId, status, summary }                 subagent 完成/失败/停止
 *   run.files_persisted        { files: [{ filename, file_id }], failed }  agent 写完文件
 *   run.memory_recall          { mode, memories }                          自动 memory 召回
 *   run.notification           { key, text, priority }                     系统通知（弹 toast）
 *   run.session_state          { state: 'idle' | 'running' | 'requires_action' }
 *   run.system_init            { agents, tools, mcp_servers, model, ... }  init 元信息
 *   run.hook.started           { hookName, hookEvent }                     hook 生命周期（仅 includeHookEvents）
 *   run.hook.response          { hookName, hookEvent, outcome }
 *   run.compact_boundary       { compactMetadata }                          compact 边界
 *   run.status                 { status }                                  compacting / requesting / null
 *   run.rate_limit             { info }                                    rate limit 变化
 *
 * 外层把 EventBus 桥接到：
 *   - WebSocket：subscribe('*') → ws.send(JSON.stringify(evt))
 *   - 文件审计：subscribe('*') → append events.jsonl
 *   - 内存测试：buffer.push(evt) 然后断言
 */

export class EventBus {
  constructor() {
    /** @type {Set<{ pattern: string, fn: (evt: object) => void }>} */
    this._listeners = new Set();
  }

  /**
   * 订阅事件。
   * @param {string} pattern - '*' 全订 / 'run.delta' 前缀 / 'run.done' 精确
   * @param {(evt: object) => void} fn
   * @returns {() => void} 取消订阅
   */
  subscribe(pattern, fn) {
    if (typeof pattern !== 'string') throw new Error('EventBus.subscribe: pattern must be string');
    if (typeof fn !== 'function') throw new Error('EventBus.subscribe: fn must be function');
    const entry = { pattern, fn };
    this._listeners.add(entry);
    return () => this._listeners.delete(entry);
  }

  /**
   * 发布事件。listener 抛错会被吞 + 控制台 warn，不影响其他订阅者。
   */
  publish(event) {
    for (const { pattern, fn } of this._listeners) {
      if (matches(pattern, event.type)) {
        try {
          fn(event);
        } catch (err) {
          console.warn(`[EventBus] listener for "${pattern}" threw:`, err.message);
        }
      }
    }
  }

  /**
   * 同步 collect 所有事件到一个数组（测试用）。返回数组 + 取消函数。
   */
  collect(pattern = '*') {
    const buffer = [];
    const off = this.subscribe(pattern, (evt) => buffer.push(evt));
    return { buffer, stop: off };
  }
}

function matches(pattern, type) {
  if (pattern === '*') return true;
  if (pattern === type) return true;
  // 前缀匹配：'run.delta' 匹配 'run.delta.text'
  return type.startsWith(pattern + '.');
}

// ── 事件构造器（type-safe helpers，调用方少写字面量）──

export const Events = {
  start: () => ({ type: 'run.start' }),
  roundStart: (round) => ({ type: 'run.round.start', round }),
  roundEnd: (round, stopReason, usage) => ({ type: 'run.round.end', round, stopReason, usage }),
  deltaText: (round, text) => ({ type: 'run.delta.text', round, text }),
  deltaThinking: (round, text) => ({ type: 'run.delta.thinking', round, text }),
  deltaToolUse: (round, blockId, name, input) => ({ type: 'run.delta.tool_use', round, blockId, name, input }),

  // 工具 streaming 起点 —— SDK content_block_start (type: tool_use) 触发，
  // 只携 blockId + name，input 此时还没流完。让前端立刻显示 icon + 名字
  // status='running'，等后续 deltaToolUse 来时同 blockId update 完整 input。
  toolUseStarted: (round, blockId, name) => ({ type: 'run.tool_use.started', round, blockId, name }),
  deltaToolResult: (round, blockId, name, ok, output, error, images) => ({
    type: 'run.delta.tool_result', round, blockId, name, ok,
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error } : {}),
    // C24：image content blocks（base64）单独传，让前端 <img src="data:..."> 渲染
    ...(images && images.length > 0 ? { images } : {}),
  }),
  todoUpdated: (todos) => ({ type: 'run.todo.updated', todos }),
  cancelled: (reason) => ({ type: 'run.cancelled', reason }),
  done: (finalText, artifactPath, snapshot) => ({
    type: 'run.done', finalText, artifactPath, snapshot,
  }),
  error: (message, code, stack) => ({ type: 'run.error', message, code, stack }),

  // ── P0+ stage 1 新增（28+ 种 SDK message 翻译）──
  toolProgress: (blockId, toolName, elapsedSeconds) => ({
    type: 'run.tool_progress', blockId, toolName, elapsedSeconds,
  }),
  promptSuggestion: (suggestion) => ({ type: 'run.prompt_suggestion', suggestion }),
  // toolUseId 关键 —— main agent 用 Task 工具调子代理时，SDK 推 task_*
  // events 都带 tool_use_id，前端用它把 task 状态绑到对应的 Task tool message
  taskStarted: (taskId, description, taskType, prompt, toolUseId) => ({
    type: 'run.task.started', taskId, description, taskType, prompt, toolUseId,
  }),
  taskProgress: (taskId, description, summary, lastToolName, usage, toolUseId) => ({
    type: 'run.task.progress', taskId, description, summary, lastToolName, usage, toolUseId,
  }),
  taskUpdated: (taskId, patch, toolUseId) => ({
    type: 'run.task.updated', taskId, patch, toolUseId,
  }),
  taskNotification: (taskId, status, summary, usage, toolUseId) => ({
    type: 'run.task.notification', taskId, status, summary, usage, toolUseId,
  }),
  filesPersisted: (files, failed) => ({ type: 'run.files_persisted', files, failed }),
  memoryRecall: (mode, memories) => ({ type: 'run.memory_recall', mode, memories }),
  notification: (key, text, priority, color, timeoutMs) => ({
    type: 'run.notification', key, text, priority, color, timeoutMs,
  }),
  sessionState: (state) => ({ type: 'run.session_state', state }),
  systemInit: (info) => ({ type: 'run.system_init', info }),
  hookStarted: (hookName, hookEvent) => ({ type: 'run.hook.started', hookName, hookEvent }),
  hookResponse: (hookName, hookEvent, outcome, output, exitCode) => ({
    type: 'run.hook.response', hookName, hookEvent, outcome, output, exitCode,
  }),

  // C4 FileChanged hook → 前端 reload iframe
  fileChanged: (filePath, event) => ({ type: 'run.file_changed', filePath, event }),

  // ── Phase 1 翻译补全 ──

  // SDKAPIRetryMessage（sdk.d.ts:2322）：API 请求失败可重试。
  // 当前 handleSystemMessage 把 'api_retry' subtype 落进 default warn —— 改为 emit
  // 让上层（前端 / 监控）能看到"还在重试"。
  // error_status: HTTP 状态码，连接错误/超时时为 null（无 HTTP 响应）。
  apiRetry: (attempt, maxRetries, retryDelayMs, errorStatus, errorKind) => ({
    type: 'run.api_retry',
    attempt,
    maxRetries,
    retryDelayMs,
    errorStatus,    // number | null
    errorKind,      // SDKAssistantMessageError union: rate_limit / server_error / ...
  }),

  // ── Phase 2 hooks 主动捕事件 ──

  // SessionStart hook：source 'startup' | 'resume' | 'clear' | 'compact'
  // 上层据此可决定要不要展示"接续上次会话"提示
  sessionStart: (source, agentType, model) => ({
    type: 'run.session_start', source, agentType, model,
  }),

  // SubagentStart hook（sdk.d.ts:5258）：主动捕子代理启动。
  // SDK system 'task_started' message 是间接路径（依赖 agentProgressSummaries），
  // 这条 hook 是更可靠的主入口。
  subagentStart: (agentId, agentType) => ({
    type: 'run.subagent.start', agentId, agentType,
  }),

  // SubagentStop hook（sdk.d.ts:5269）：子代理结束。带 last_assistant_message 字段
  // 不用读 transcript 也能拿到收尾文本。
  subagentStop: (agentId, agentType, lastAssistantMessage, transcriptPath) => ({
    type: 'run.subagent.stop',
    agentId, agentType,
    lastAssistantMessage,    // 可选；agent 收尾的最后一句
    transcriptPath,          // 可选；子代理转录文件路径，前端展开"完整对话"用
  }),

  // PostToolUseFailure hook：工具失败，hook 已注入了恢复建议给 agent，
  // 上层只需可见"哪个工具失败了"做监控/告警。
  toolFailure: (toolName, error) => ({
    type: 'run.tool_failure', toolName, error,
  }),

  // ── Canvas 焕新升级 S1（2026-05-02）──

  // S1d PostToolUse(Edit|Write canvas.html) hook 自动检测改动的 page 号 emit。
  // 前端 SlideNavigator 收到后自动 scrollIntoView + 1.5s pulse 高亮该 section。
  // pages: number[] —— 一次 Edit 可能跨多页（罕见），通常单元素。
  // anchor: 可选，data-anchor 值（如 'cover-title'），前端能精确高亮元素而非整页。
  canvasFocusPage: (pages, anchor) => ({
    type: 'run.canvas_focus_page',
    pages,
    ...(anchor ? { anchor } : {}),
  }),

  // ── Canvas 焕新 C1（2026-05-02）：MCP 工具反向通道 + tweaks/buffer 通知 ──

  // navigate_to_page 工具触发，前端 ProjectWorkspace 收到后切到第 N 页
  // （SlideNavigator setActivePage / iframe 内 scrollIntoView section[data-page="N"]）
  canvasNavigate: (page) => ({ type: 'run.canvas_navigate', page }),

  // highlight 工具触发，前端在 InspectFloatingCard 同层挂 pulse overlay
  canvasHighlight: (selector, durationMs = 1500) => ({
    type: 'run.canvas_highlight', selector, durationMs,
  }),

  // expose_tweaks 工具完成，前端 TweaksPanel reload spec.tweaks
  tweaksExposed: (count, added, replaced) => ({
    type: 'run.tweaks_exposed', count, added, replaced,
  }),

  // clear_pending_changes 工具完成，前端可清相应本地 pending hint
  pendingChangesCleared: (removed, remaining) => ({
    type: 'run.pending_changes_cleared', removed, remaining,
  }),

  // ── A4.1（2026-05-02）：AskUserQuestion 走 SDK canUseTool 路径 ──
  //
  // SDK binary 把 AskUserQuestion 设为 `shouldDefer: true` + `requiresUserInteraction: true`，
  // 工具的 checkPermissions 总返 `behavior: 'ask', message: 'Answer questions?'`，
  // 等 host 程序通过 canUseTool callback 返 `behavior: 'allow', updatedInput: {
  // ...input, answers: {...} }`，binary 拿到带 answers 的 input → 调 tool.call →
  // 工具直接返回 answers 作 result（cli.js:GR6.call 实现）。
  //
  // 我们的 canUseTool（loop.js）拦到此事件 → emit run.ask_user_question →
  // 前端 AskUserQuestionView 卡片 → 用户点选项 → POST /answer → resolve
  // canUseTool 的 await，返回 updatedInput。
  //
  // questions 是从工具 input 摘出的 `{ question, header, options, multiSelect }[]`
  // 数组（详见 cli.js:zHK schema），前端按现有卡片字段直接消费。
  askUserQuestion: (toolUseId, questions) => ({
    type: 'run.ask_user_question',
    toolUseId,
    questions,
  }),

  // ── A1.2（2026-05-02）：实时上下文用量 ──
  // SDKControlGetContextUsageResponse（sdk.d.ts:2451-2541）由 query.getContextUsage()
  // 返回。loop.js 在每个 assistant message 后 await 一次 emit，前端 ContextUsageBar
  // 接事件渲进度条 + breakdown + autoCompact 阈值预警。
  //
  // 关键字段（为前端做轻量化封装，不全量透传以节省 ws 带宽）：
  //   totalTokens / maxTokens / percentage      — 主进度条数据
  //   autoCompactThreshold                       — 触发 autoCompact 的阈值（绝对 token）
  //   isAutoCompactEnabled                        — 当前开关状态（前端预警条件之一）
  //   model                                       — 当前模型 id
  //   messageBreakdown.toolCallsByType            — 工具消耗 token 排名（展开看）
  //   memoryFiles / mcpTools / agents / skills    — 各类目消耗（展开看）
  //
  // categories / gridRows 不传 —— 前端不渲网格，只用 percentage + breakdown。
  contextUsage: (usage) => ({
    type: 'run.context_usage',
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    autoCompactThreshold: usage.autoCompactThreshold,
    isAutoCompactEnabled: usage.isAutoCompactEnabled,
    model: usage.model,
    // 轻量化 breakdown — 前端 hover/expand 能看到细节，不渲细节时不占空间
    messageBreakdown: usage.messageBreakdown ? {
      toolCallTokens: usage.messageBreakdown.toolCallTokens,
      toolResultTokens: usage.messageBreakdown.toolResultTokens,
      attachmentTokens: usage.messageBreakdown.attachmentTokens,
      assistantMessageTokens: usage.messageBreakdown.assistantMessageTokens,
      userMessageTokens: usage.messageBreakdown.userMessageTokens,
      // toolCallsByType 是排行（用于"哪个工具吃 token 最多"），保留 top 10
      toolCallsByType: (usage.messageBreakdown.toolCallsByType || [])
        .slice(0, 10),
    } : null,
    // 类目级别 token 数（聚合，不传完整数组）
    memoryFilesTokens: (usage.memoryFiles || []).reduce((s, m) => s + (m.tokens || 0), 0),
    mcpToolsTokens: (usage.mcpTools || []).reduce((s, t) => s + (t.tokens || 0), 0),
    agentsTokens: (usage.agents || []).reduce((s, a) => s + (a.tokens || 0), 0),
  }),
};
