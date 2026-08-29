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
 *   run.tool_use_summary       { summary, blockIds }  SDK helper 对一批工具调用的一句话总结
 *   run.delta.thinking         { round, text }
 *   run.delta.tool_use         { round, blockId, name, input }
 *   run.delta.tool_input       { round, blockId, name, filePath?, append?, done? }  Edit/Write 入参真流式（节流后的字段尾巴增量，工作台舞台层直播代码用）
 *   run.delta.tool_result      { round, blockId, name, ok, output?, error? }
 *   run.todo.updated           { todos }
 *   run.cancelled              { reason }
 *   run.done                   { finalText, artifactPath?, snapshot }
 *   run.error                  { message, code?, stack? }
 *
 *   ── P0+ stage 1 新增（SDK 28+ 种 message 类型映射）──
 *   run.tool_progress          { blockId, toolName, elapsedSeconds }      工具执行中（>1s 才发）
 *   run.prompt_suggestion      { suggestion }                              每轮后预测下条 prompt
 *   run.task.started           { taskId, description, subagentType, taskType }  subagent 启动（只发真子代理，bash/workflow 任务被收口）
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
 *   run.image_generated        { path, sizeBytes, prompt, assetRole, ... } generate_image 完成（Phase A）
 *   board.updated              { objectId, zoneId, summary }               pin_to_board 改画布布局（sessionId:null 广播，前端整份重拉 board.json）
 *   board.focus                { rect, tag, layer, soft, chalk }           agent 落了草图/板书（sessionId:null 广播；黑板模式跟镜头，chalk 进精灵追踪）
 *   project.active_session     { activeSessionId }                         项目级会话指针变更（故意不带 sessionId —— 见构造器注释）
 *
 * 外层把 EventBus 桥接到：
 *   - WebSocket：subscribe('*') → ws.send(JSON.stringify(evt))
 *   - 文件审计：subscribe('*') → append events.jsonl
 *   - 内存测试：buffer.push(evt) 然后断言
 */

import { resolveModelContextWindow, brandOfModel } from './model-context.js';

/**
 * Replay buffer 容量：单 project bus 保留最近 N 条事件供 WS 重连回放。
 * 一次 turn 可能 emit 上千条 delta（thinking / text / tool）；2000 够覆盖典型
 * 几秒到几十秒的网络抖动重连窗口。FAR 旧的事件会被 client 通过 Sessions hydrate
 * 重新拉，不依赖 buffer。
 */
const REPLAY_BUFFER_SIZE = 2000;

export class EventBus {
  constructor() {
    /** @type {Set<{ pattern: string, fn: (evt: object) => void }>} */
    this._listeners = new Set();
    /** 单调递增 seq，每个 publish 自增一；event.seq 已存在则不覆盖 */
    this._seq = 0;
    /** Ring buffer：保留最近 REPLAY_BUFFER_SIZE 条事件；FIFO 满了就 shift 最旧 */
    this._buffer = [];
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
   * 副作用：分配 event.seq（若调用方未显式带 seq）+ 进入 ring buffer。
   */
  publish(event) {
    if (event.seq == null) event.seq = ++this._seq;
    this._buffer.push(event);
    if (this._buffer.length > REPLAY_BUFFER_SIZE) this._buffer.shift();

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
   * Replay-then-live 订阅 — WS 重连用。
   *
   * 流程（单线程 Node 保证原子，subscribe 与 buffer 快照间无 publish 触发）：
   *   1. subscribe('*') —— listener 把进来的事件先 push 到 queue（live=false）
   *   2. 同步遍历 buffer，filter seq > since，对每条调 fn（dedupe 用 set）
   *   3. drain queue —— 跳过 seq 已 replay 过的（buffer 和 queue 边界重叠）
   *   4. 切 live，listener 直接 fn(evt)
   *
   * gap 判断：
   *   - 客户端 since=0 → 首次连，无 replay 需求 → gap=false
   *   - since > _seq → server 重启过，client 看过的 seq 现在不存在 → gap=true
   *   - buffer 最旧 seq > since+1 → 中间一段被 ring 挤掉了 → gap=true
   *   - 否则 buffer 完整覆盖 (since, _seq] → gap=false
   *
   * @param {number} since - 客户端最后看到的 seq（0 = 没看过任何事件）
   * @param {(evt: object) => void} fn
   * @returns {{ unsubscribe: () => void, replayed: number, gap: boolean }}
   */
  subscribeFromSeq(since, fn) {
    let live = false;
    const queue = [];
    const off = this.subscribe('*', (evt) => {
      if (!live) queue.push(evt);
      else fn(evt);
    });

    const needsReplay = since > 0 && since < this._seq;
    const buffered = this._buffer.length > 0;
    const restarted = since > this._seq;
    const gap = restarted || (needsReplay && (!buffered || this._buffer[0].seq > since + 1));

    // since=0 也 replay buffer 里 seq>0 的事件 —— ws/index.js 调用前先 await sendHydrate
    // 是异步阻塞（拉 jsonl 100~数百 ms），期间若 agent emit 事件进 buffer 但 listener
    // 还没 attach，老逻辑 `since > 0 ? ... : []` 让 since=0 时 replay=[] → 这些事件全丢，
    // 用户报"发 chat 后 agent 不回应"。改成无条件 filter：since=0 + buffer 空（首连）→
    // replay=[] 不变；since=0 + buffer 含 hydrate 期间事件 → 全 replay 推前端。
    const replay = this._buffer.filter(e => e.seq > since);
    const replayedSeqs = new Set();
    for (const evt of replay) {
      replayedSeqs.add(evt.seq);
      try { fn(evt); }
      catch (err) { console.warn(`[EventBus] replay listener threw:`, err.message); }
    }
    for (const evt of queue) {
      if (replayedSeqs.has(evt.seq)) continue;
      try { fn(evt); }
      catch (err) { console.warn(`[EventBus] queue drain threw:`, err.message); }
    }
    live = true;
    return { unsubscribe: off, replayed: replay.length, gap };
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
  // 铅笔精灵的手写短句（2026-08-14 日记本批）：回合内回复的压缩旁白，
  // 本地整形、一条 assistant 消息一发。⚠️ 2026-08-19 前这里同一 round 会来
  // 两发（首句底稿 refined:false + haiku 精修 refined:true，前端后到覆盖）——
  // 那发 haiku 写死走订阅、不跟随会话模型，整条线路已拆，`refined` 随之取消。
  // 收场 recap（run.recap）是同一条 haiku 通道的另一个出口，同批退役。
  spriteSummary: (round, text) => ({ type: 'run.sprite_summary', round, text }),
  // SDK helper 生成的一句话工具批摘要（Claude Code 侧栏那种折叠标题）
  toolUseSummary: (summary, blockIds) => ({ type: 'run.tool_use_summary', summary, blockIds }),
  deltaThinking: (round, text) => ({ type: 'run.delta.thinking', round, text }),
  deltaToolUse: (round, blockId, name, input) => ({ type: 'run.delta.tool_use', round, blockId, name, input }),
  // 真流式工具入参（2026-07-28）：patch = { filePath?, append?, done? }。
  // append 是抽出字段（Edit.new_string / Write.content）相对上次的纯文本增量
  deltaToolInput: (round, blockId, name, patch) => ({ type: 'run.delta.tool_input', round, blockId, name, ...patch }),

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

  // streamInput 重构（Phase 2）：session-level query 起停事件，跟 per-turn
  // run.start/done 区分 —— 前端用它判断"会话还活着，能继续追加" vs "会话死了"
  querySessionStart: (sessionId) => ({ type: 'run.query.start', sessionId }),
  querySessionEnd: (sessionId, reason) => ({ type: 'run.query.end', sessionId, reason }),
  // 排队提示：用户在 agent 跑时追加消息，UI 显示"已排队 N 条"
  queueDepth: (sessionId, depth) => ({ type: 'run.queue.depth', sessionId, depth }),

  // ── 会话收敛 E1a（2026-08-13）：项目级 active session 指针变更广播 ──
  //
  // 会话真相源收敛到 projects.active_session_id（服务端指针）之后，指针一动
  // 就广播这条，同项目的其他标签页靠它把自己对齐到服务端真相。
  //
  // ⚠️ 这条事件**绝对不能带 sessionId 字段**：ws/index.js 的下发过滤器是
  // `event.sessionId && event.sessionId !== sid` —— 带上的话，正开着**别的**
  // 会话（或还没有会话）的标签页会把它过滤掉，而那些标签页恰恰是最需要
  // 知道"指针已经指向别处"的人。载荷字段叫 activeSessionId，绕开过滤器的
  // 同时语义也更准：它是指针的新值，不是"这条事件属于哪个会话"。
  // activeSessionId 可为 null（指针被清空，比如指向的会话被删）。
  projectActiveSession: (activeSessionId) => ({ type: 'project.active_session', activeSessionId }),

  // ── P0+ stage 1 新增（28+ 种 SDK message 翻译）──
  toolProgress: (blockId, toolName, elapsedSeconds) => ({
    type: 'run.tool_progress', blockId, toolName, elapsedSeconds,
  }),
  promptSuggestion: (suggestion) => ({ type: 'run.prompt_suggestion', suggestion }),
  // toolUseId 关键 —— main agent 用 Task 工具调子代理时，SDK 推 task_*
  // events 都带 tool_use_id，前端用它把 task 状态绑到对应的 Task tool message
  // ⚠️ 只发真子代理（agent-shared.js isSubagentTask 收口）：SDK 的统一任务
  // 系统里后台 Bash / Workflow 也发 task_*，那些不进这条事件。
  // subagentType = SDK task_started.subagent_type（explorer / vision-checker
  // 这种真名）；taskType 是 'local_agent' 这类泛名，只作兜底展示。
  taskStarted: (taskId, description, subagentType, taskType, prompt, toolUseId) => ({
    type: 'run.task.started', taskId, description, subagentType, taskType, prompt, toolUseId,
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

  /**
   * 板书/草图落定广播（sessionId:null）。原是 write-on-board / sketch-on-board
   * 里两份内联对象 —— 08-24 板书进精灵追踪链后它有了第三个读者（在场 reducer
   * 认 chalk 字段），形状收进构造器钉住（前端 parity 测试对着这里逐字校）。
   * chalk = 板书文件的工作区相对路径（就是它的画布 id）；草图不传。
   */
  // actor：这次落定是谁干的（常驻角色的 slug）。**必须带**：board.focus 是板书落定的
  // 唯一信号，画布的在场表靠它给精灵定位。不带的话角色的板书会被记到主 agent 头上
  // —— 主精灵瞬移到角色写的东西上（08-18 拆子代理精灵的病根），而角色自己的精灵
  // 因为永远拿不到 targetId 而从不出现（2026-08-26 审出）。
  boardFocus: (rect, { tag = null, layer = '', soft = false, chalk = null, actor = null } = {}) => (
    { type: 'board.focus', sessionId: null, rect, tag, layer, soft, chalk, ...(actor ? { actor } : {}) }
  ),

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
  // toolUseId：SDK callback 第 2 参，是触发该 subagent 启动的 main agent
  // Task tool_use_id —— 前端能用它把 critique 挂回对应的 Task message。
  subagentStop: (agentId, agentType, lastAssistantMessage, transcriptPath, toolUseId) => ({
    type: 'run.subagent.stop',
    agentId, agentType,
    lastAssistantMessage,    // 可选；agent 收尾的最后一句
    transcriptPath,          // 可选；子代理转录文件路径，前端展开"完整对话"用
    ...(toolUseId ? { toolUseId } : {}),
  }),

  // （run.role.wait / run.scene 2026-08-29 随收件箱与场声明一起退役：角色写完一段
  //  就结束这一轮，「在写 / 写完了」直接由 subagentStart / subagentStop 表达。）

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

  // preview_deck 工具触发：前端把这张 deck 卡"替用户双击一下"
  //（收起态→内嵌渲染；已展开→画布内最大化窗）。path 为 null = 当前会话的 deck
  deckPreview: (filePath) => ({ type: 'run.deck_preview', path: filePath || null }),

  // highlight 工具触发，前端在 InspectFloatingCard 同层挂 pulse overlay
  canvasHighlight: (selector, durationMs = 1500) => ({
    type: 'run.canvas_highlight', selector, durationMs,
  }),

  // expose_tweaks 工具完成，前端 TweaksPanel reload spec.tweaks
  tweaksExposed: (count, added, replaced) => ({
    type: 'run.tweaks_exposed', count, added, replaced,
  }),

  // clear_pending_changes 工具完成，前端可清相应本地 pending hint。
  // clearedIds 让前端 comments state 精确 filter 出橙色 overlay（前后端 id 已统一）
  pendingChangesCleared: (clearedIds, removed, remaining) => ({
    type: 'run.pending_changes_cleared', clearedIds, removed, remaining,
  }),

  // ── A4.1（2026-05-02）：AskUserQuestion 走 SDK canUseTool 路径 ──
  //
  // SDK binary 把 AskUserQuestion 设为 `shouldDefer: true` + `requiresUserInteraction: true`，
  // 工具的 checkPermissions 总返 `behavior: 'ask', message: 'Answer questions?'`，
  // 等 host 程序通过 canUseTool callback 返 `behavior: 'allow', updatedInput: {
  // ...input, answers: {...} }`，binary 拿到带 answers 的 input → 调 tool.call →
  // 工具直接返回 answers 作 result（cli.js:GR6.call 实现）。
  //
  // 我们的 canUseTool（session-loop.js）拦到此事件 → emit run.ask_user_question →
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
  // 返回。session-loop.js 在每个 assistant message 后 await 一次 emit，前端 ContextUsageBar
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
  // ── 图片生成（Phase A，2026-05-06 后段）──
  // generate_image MCP 工具调完后 emit。前端可在 chat / timeline 实时插
  // thumbnail，并把 path 关联回 spec.json 的 record_decision 节点。
  // 字段：
  //   path             agent cwd 相对路径（assets/generated/<file>.png）
  //   absPath          绝对落地路径（前端不一定用，便于审计）
  //   sizeBytes        png 字节数
  //   prompt           生成 prompt 全文
  //   assetRole        语义类（hero/cover/bg/.../pattern），可空
  //   aspectRatio / imageSize    生成参数
  //   referenceImageCount         喂进去的参考图数量
  //   accompanyText    模型可选的文字 commentary（responseModalities 含 TEXT 时才有）
  imageGenerated: (info) => ({
    type: 'run.image_generated',
    path: info.path,
    absPath: info.absPath,
    sizeBytes: info.sizeBytes,
    prompt: info.prompt,
    assetRole: info.assetRole || null,
    aspectRatio: info.aspectRatio,
    imageSize: info.imageSize,
    referenceImageCount: info.referenceImageCount || 0,
    ...(info.accompanyText ? { accompanyText: info.accompanyText } : {}),
  }),

  // appModel: NoDesign 上层真实 model（如 kimi-k2.6）。spoofing 后 SDK 的
  // usage.model 是 alias（如 claude-opus-4-7[1m]）不可信；调用方需把真 appModel
  // 传进来。给定 appModel 时按真实容量算 maxTokens / percentage，前端 ContextUsageBar
  // 显的就是 gateway 真正能扛的容量（不是 SDK 内部 compact 触发线）。
  contextUsage: (usage, appModel = null) => {
    // 这里 import 在 file 顶（已加），避免循环依赖问题
    //
    // 分母的兜底链只能有一条（2026-07-30）：以前 hooks.js 那个生产者自己写了
    // 一条更长的（?? rawMaxTokens ?? 256000），两条链在 appModel 缺失时给出不同
    // 的分母，同一个会话前后两次百分比对不上。合并到这里，256000 那个 kimi 时代
    // 的常量去掉 —— 拿它当 Claude 会话的分母只会算出个假的高百分比。
    const realMax = (appModel ? resolveModelContextWindow(appModel) : null)
      ?? usage.maxTokens
      ?? usage.rawMaxTokens
      ?? null;
    const totalTokens = usage.totalTokens;
    const percentage = realMax > 0 ? Math.round((totalTokens / realMax) * 100) : (usage.percentage || 0);
    return {
    type: 'run.context_usage',
    totalTokens,
    maxTokens: realMax,                  // 真实容量（kimi=256k）—— 前端进度条分母
    sdkMaxTokens: usage.maxTokens,       // SDK 给的（compact 触发线 230k）—— debug
    percentage,
    autoCompactThreshold: usage.autoCompactThreshold,
    isAutoCompactEnabled: usage.isAutoCompactEnabled,
    model: appModel || usage.model,
    // 出自谁家（BRANDS 之一）——画布精灵据此换身份标。⚠️ 不能让前端读 SDK 的 usage.model 去认牌子：
    // spoofing 之后那是 alias（DeepSeek 行报 claude-opus-4-7[1m]），照它认牌子会把鲸画成星芒
    brand: appModel ? brandOfModel(appModel) : null,
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
    };
  },
};
