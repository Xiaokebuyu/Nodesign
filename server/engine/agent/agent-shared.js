/**
 * engine/agent/agent-shared.js — agent 跑 run 时复用的常量 + 翻译层
 *
 * 历史：原 `session-loop.js` 含 runAgent (per-turn 一次性 query 模式)。streamInput 重构后
 * 生产代码切到 session-loop.js (runSession，long-running query 跨多 turn)，
 * runAgent 死掉。本文件保留 session-loop.js 仍依赖的部分：
 *
 *   - NODESIGN_PRELUDE / NODESIGN_PLAN_INSTRUCTIONS  系统 prompt 段
 *   - DEFAULT_TOOL_ALLOWLIST / STREAMING_ENABLED     SDK options 默认值
 *   - handleSDKMessage / detectArtifact               SDK 消息 → EventBus 翻译层
 *
 * 调用方：server/engine/agent/session-loop.js (runSession)
 */

import { Events } from './events.js';
import { callerOf } from './actor-trail.js';
import { handleTaskMessage } from './task-events.js';
import { listWorkspaceArtifacts } from '../../lib/artifact-target.js';
import { toWorkspaceRel } from '../../lib/workspace-path.js';
import { parse as parsePartialJson, Allow as PartialAllow } from 'partial-json';

// 系统提示词（prelude / plan instructions 的加载与渲染）2026-08-19 迁去
// ./system-prompts.js —— 那一块跟本文件其余部分（SDK 消息翻译层 + options
// 默认值）零耦合，放一起纯属历史。session-loop 直接从新模块拿，这里不转出口：
// 转一手就是给"从哪 import"开第二个答案。

// SDK base 工具白名单（Options.tools，sdk.d.ts:1216）—— 限定主 agent 可见的
// **内置工具**集合。MCP 工具（mcp__nodesign__*）由 mcpServers 字段独立暴露，
// 不需要列在这里；新加内置工具按需追加。
//
// 设计要点：
//   - Bash 是必需（git/playwright/zip 都靠它）。沙盒由 OS 级 sandbox 字段保证
//   - AskUserQuestion 是 deferred 工具：bypassPermissions 不影响它；canUseTool
//     callback 拦截它注入用户答案（session-loop.js canUseTool 段）
//   - WebFetch（SDK 内置）走 binary 自带的 prompt 总结，不灌完整 HTML 给 model；
//     WebSearch 走我们自己的 mcp__nodesign__web_search（4 provider，免 server_tool_use）
//   - Task 是子代理调用入口；agents 字段注册的子代理通过 Task 暴露给主 agent。
//     **Task 漏挂 = 所有子代理形同摆设**（P0+ stage 1 修复过一次的隐性 bug）
//     工具真名在 SDK 0.3 已改叫 `Agent`，'Task' 走 sdk.mjs 的旧名映射表（i6）
//     照样解析成 Agent，故此处不必改名
//   - TaskOutput 是**子代理报告的取回口**（2026-08-03 加）。子代理默认后台跑，
//     后台跑时 tool_result 里只有一句 "Async agent launched successfully"，
//     完成通知也只给一个 output_file 路径 —— 那个路径是 SDK 转录 jsonl，既在
//     cwd + additionalDirectories 之外（Read 够不着），又明令不许读（会撑爆上下文）。
//     漏挂 TaskOutput 的后果是主 agent 眼睁睁看着子代理跑完却拿不到结果：实测它
//     会去 ToolSearch 找 SendMessage，找不到，然后放弃改用自己的记忆硬写。
//     hooks.js 已强制前台（正常路径拿得到报告），这里是兜底的第二条路。
//
// 非显式语义：
//   - tools 字段是"可见集合"白名单，不在里面的内置工具会被剥离
//   - 不是 auto-allow（auto-allow 由 permissionMode='bypassPermissions' 已经全
//     跳）。之前 sdkOptions 同设 allowedTools 是冗余，已删
//   - **Skill 必须显式列出**：SDK `skills:` option 只把 `Skill(<name>)` 注入到
//     `allowedTools`（权限层），**不动 tools 数组**（可见集层）。漏列 Skill =
//     `--tools` flag 显式不含 Skill → CLI binary 把 Skill 工具从 agent 可见集
//     剥离 → 即使 plugins+skills option 都传对了，agent 也看不到 Skill 工具，
//     永远调不到任何 SDK skill。SDK 文档 sdk.d.ts:1651 那句 "do not need to
//     add Skill to allowedTools" 只承诺权限层，没承诺可见层。
export const DEFAULT_TOOL_ALLOWLIST = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash',
  'AskUserQuestion',
  'WebFetch',
  'Task',
  'TaskOutput',
  // 常驻角色（rp-*，见 cast.js）的唯一叫醒方式。SendMessage 是 **deferred 工具**：
  // 列在这里只是进了可见集，模型还得先 ToolSearch('select:SendMessage') 取 schema
  // 才能调（2026-08-26 探针实测，主代理和子代理都会自己去取，不用教）。
  // 漏挂的后果不是报错而是够不着：主代理派出去的角色再也叫不回来。
  'SendMessage',
  'Skill',
  // deferred MCP 工具的取 schema 入口（ENABLE_TOOL_SEARCH=true 时生效）。
  // 漏挂 = 延迟加载的工具永远调不到（同 Skill 的可见集陷阱）
  'ToolSearch',
];

// 旧式（cwd 根）产物候选 —— canvas.html 列首位，其余兼容 deec72d 之前的
// e2e smoke / 旧 deskskill-engine 输出。任务模型下产物不在 cwd 根，走
// listWorkspaceArtifacts（见 detectArtifact）。
const ARTIFACT_CANDIDATES = ['canvas.html', 'deck.html', 'index.html', 'output.html'];

// P0+ s1 C24：流式打字效果（text / thinking 逐 token 推送）。
// 跟 sdkOptions.includePartialMessages 同步 —— 我们默认开（前端要打字效果）。
// 启用时 handleAssistantBlocks 跳过 text/thinking blocks（已经从 stream_event 推完，
// 避免双推），但仍推 tool_use 完整 block（run.delta.tool_use 是入参的权威快照；
// Edit/Write 另有节流的 run.delta.tool_input 真流式增量，见 handleStreamEvent）。
export const STREAMING_ENABLED = true;


// ── SDK message → EventBus 翻译层 ──

/**
 * 把 SDK 各种 message 类型翻译成 Nodesign 内部事件。
 * SDKMessage union 见 sdk.d.ts:2988（28+ 种 type/subtype 组合）。
 *
 * 翻译策略：
 * - 主流程消息（assistant / user / result）：走 handleAssistantBlocks / handleUserBlocks
 * - SDK system subtype 多达 14 种：分派到对应 Events 构造器
 * - 旁路类型（stream_event / keep_alive）：noop（前端不需要）
 */
export function handleSDKMessage(ctx, msg) {
  // 首条 message 含 session_id，记下
  if (msg.session_id) ctx.recordSdkSession(msg.session_id);

  // 子代理时间轴（2026-07-28）：forwardSubagentText 开启后，子代理的消息带
  // parent_tool_use_id 流进主 query。用原型链派生一个 emit 装饰过的 ctx——
  // 该 message 产生的所有事件都盖上 parentToolUseId，前端据此拆时间轴。
  // Object.create 保 AgentContext 的原型方法与共享状态（counters 等）原样可用。
  if (msg.parent_tool_use_id) {
    const parent = msg.parent_tool_use_id;
    // 先确保流式入参 map 已挂在真 ctx 上 —— 否则首次访问发生在派生对象上，
    // map 会写成派生对象的 own property，随派生对象丢弃（原型链只読共享）
    toolInputStreams(ctx);
    // ⚠️ 必须捕获 base 快照：闭包若直接引用 ctx 变量，下面 ctx = child 之后
    // ctx.emit 会解析回 child 自己 → 无限递归（真机爆过 Maximum call stack）
    const base = ctx;
    const child = Object.create(base);
    // actor：这条事件是谁干的（常驻角色的 slug）。parentToolUseId 是**派发那次
    // Agent 调用**的 id，而派发闸在那一刻按同一个 id 盖过章 —— 查回来就知道
    // 是哪个角色。画布的在场表据此给每个角色立自己的精灵（不然全算主 agent
    // 头上，主精灵会在角色写的东西之间瞬移，那正是 08-18 把子代理精灵拆掉的原因）。
    const actor = callerOf(parent)?.agentType || null;
    child.emit = (evt) => base.emit({ parentToolUseId: parent, ...(actor ? { actor } : {}), ...evt });
    ctx = child;
  }

  switch (msg.type) {
    case 'assistant':
      // BetaMessage 含 content[] (text / thinking / tool_use blocks)
      // STREAMING_ENABLED 时 text/thinking 已从 stream_event 推完，跳过避免双推。
      // 例外：子代理消息（forwardSubagentText 转发）没有对应 stream_event，
      // 跳过会把子代理正文整段吞掉（时间轴就空了）—— 不跳。
      handleAssistantBlocks(ctx, msg.message?.content || [], STREAMING_ENABLED && !msg.parent_tool_use_id);
      break;

    case 'user':
      // 一般是 tool_result 反馈（agent loop 中 SDK 会回填）
      handleUserBlocks(ctx, msg.message?.content || []);
      break;

    case 'system':
      handleSystemMessage(ctx, msg);
      break;

    case 'stream_event':
      // SDKPartialAssistantMessage —— 流增量（includePartialMessages: true）
      // 推逐 token text_delta / thinking_delta 给前端实现打字效果
      if (STREAMING_ENABLED) handleStreamEvent(ctx, msg);
      break;

    case 'tool_use_summary':
      // SDKToolUseSummaryMessage —— SDK 的 helper model 对刚才那批工具调用写的
      // 一句话总结（Claude Code 侧栏折叠标题就是它）。以前当旁路审计丢掉了，
      // 于是前端只能自己切 thinking 头 60 字当标题。现在转发给前端当分组标题。
      if (msg.summary) {
        ctx.emit(Events.toolUseSummary(msg.summary, msg.preceding_tool_use_ids || []));
      }
      break;

    case 'tool_progress':
      // SDKToolProgressMessage —— 工具执行 >1s 时定期推（前端可显示"读取中 12s..."）
      ctx.emit(Events.toolProgress(msg.tool_use_id, msg.tool_name, msg.elapsed_time_seconds));
      break;

    case 'prompt_suggestion':
      // SDKPromptSuggestionMessage —— 每轮后 piggyback 预测的下条 prompt
      // 前端 SuggestionChip（C19）渲染
      ctx.emit(Events.promptSuggestion(msg.suggestion));
      break;

    case 'status':
      // SDKStatusMessage —— 'compacting' | 'requesting' | null
      ctx.emit({ type: 'run.status', status: msg.status });
      break;

    case 'rate_limit_event':
      ctx.emit({ type: 'run.rate_limit', info: msg.rate_limit_info });
      break;

    case 'auth_status':
      // 鉴权状态（首次 spawn 时可能出现）
      if (msg.error) {
        ctx.emit({ type: 'run.auth_error', message: msg.error });
      }
      break;

    case 'keep_alive':
      // SDKKeepAliveMessage —— WS 心跳，不入 EventBus
      break;

    case 'result':
      // 由外层 for await 捕获处理（finalText / artifactPath / counters）
      break;

    default:
      // 兜底：未识别的新 type 留个调试痕迹，方便 SDK 升级时发现
      console.warn(`[run ${ctx.runId}] unknown SDK message type:`, msg.type);
      break;
  }
}

/**
 * SDK type:'system' 下的 14 种 subtype 派发。集中放一处便于维护。
 */
function handleSystemMessage(ctx, msg) {
  switch (msg.subtype) {
    case 'init':
      // 初始化元信息：agents / tools / mcp_servers / model / permissionMode 等
      // model：SDK 看到的是 spoofing alias（如 claude-opus-4-7[1m]，让 SDK 信
      // rawMaxTokens=1M 解 Kimi 256k 卡顿，详见 model-context.js）。前端 InfoChips
      // 显示 appModel（kimi-k2.6 真名）才不让用户困惑。
      ctx.emit(Events.systemInit({
        agents: msg.agents,
        tools: msg.tools,
        mcpServers: msg.mcp_servers,
        model: ctx.appModel || msg.model,
        permissionMode: msg.permissionMode,
        skills: msg.skills,
        plugins: msg.plugins,
        claudeCodeVersion: msg.claude_code_version,
        cwd: msg.cwd,
      }));
      break;

    case 'compact_boundary':
      ctx.counters.compactBoundaries += 1;
      ctx.emit({ type: 'run.compact_boundary', compactMetadata: msg.compact_metadata });
      break;

    case 'api_retry':
      // SDKAPIRetryMessage（sdk.d.ts:2322）：API 请求失败，可重试，将在 retry_delay_ms 后重试。
      // 之前落到 default warn —— 改为 emit 让上层能看到"网络抖了，agent 还在重试"，
      // 避免用户以为卡死。
      ctx.emit(Events.apiRetry(
        msg.attempt,
        msg.max_retries,
        msg.retry_delay_ms,
        msg.error_status,        // number | null（连接错误时为 null）
        msg.error,               // SDKAssistantMessageError union
      ));
      break;

    case 'files_persisted':
      // SDKFilesPersistedEvent —— agent 写完 file checkpoint 持久化通知
      // FileChanged hook 触发的 file.changed 事件是更直接的；这个仅审计
      ctx.emit(Events.filesPersisted(msg.files, msg.failed));
      break;

    case 'memory_recall':
      // 自动 memory 召回 —— 前端可显示"recalled from memory"
      ctx.emit(Events.memoryRecall(msg.mode, msg.memories));
      break;

    case 'task_started':
    case 'task_progress':
    case 'task_updated':
    case 'task_notification':
      // SDK 统一任务消息族（后台 Bash / Workflow 也发 task_*）：收口翻译
      // 住 task-events.js —— 只放真子代理进 run.task.*
      handleTaskMessage(ctx, msg);
      break;

    case 'notification':
      // SDKNotificationMessage —— 系统级 toast（priority: low/medium/high/immediate）
      ctx.emit(Events.notification(msg.key, msg.text, msg.priority, msg.color, msg.timeout_ms));
      break;

    case 'session_state_changed':
      ctx.emit(Events.sessionState(msg.state));
      break;

    case 'hook_started':
      ctx.emit(Events.hookStarted(msg.hook_name, msg.hook_event));
      break;

    case 'hook_progress':
      // hook 执行中 stdout/stderr 流（仅 includeHookEvents: true 时）
      // 前端不需要，旁路日志即可
      break;

    case 'hook_response':
      ctx.emit(Events.hookResponse(
        msg.hook_name, msg.hook_event, msg.outcome, msg.output, msg.exit_code,
      ));
      break;

    case 'plugin_install':
      // 插件安装进度（headless mode），不入 EventBus
      break;

    case 'local_command_output':
      // 本地 slash command 输出（/voice / /usage 等），不入 EventBus
      break;

    case 'elicitation_complete':
      // MCP elicitation URL 模式完成确认，旁路
      break;

    case 'mirror_error':
      // SessionStore mirror 失败，旁路（我们没用 SessionStore）
      break;

    case 'status':
      // SDK 进度/心跳状态 → 转发（前端 header 存活点 + compacting toast 消费；
      // 曾被旁路，是"前端不知道后端死活"的帮凶之一）
      ctx.emit({ type: 'run.status', status: msg.status });
      break;

    case 'thinking_tokens':
      // SDK 0.3+ 思考进度心跳（~1s 一条，estimated_tokens 累计值）。
      // 转成 run.status 让前端知道"在思考、没死"并可显示进度。
      ctx.emit({
        type: 'run.status', status: 'thinking', tokens: msg.estimated_tokens,
      });
      break;

    default:
      console.warn(`[run ${ctx.runId}] unknown system subtype:`, msg.subtype);
      break;
  }
}

function handleAssistantBlocks(ctx, content, skipTextThinking = false) {
  for (const block of content) {
    switch (block.type) {
      case 'text':
        // 流式开了 → text 已通过 stream_event 推完，跳过避免重复
        if (!skipTextThinking && block.text) {
          ctx.emit(Events.deltaText(ctx.counters.turns, block.text));
        }
        break;
      case 'thinking':
        if (!skipTextThinking && block.thinking) {
          ctx.emit(Events.deltaThinking(ctx.counters.turns, block.thinking));
        }
        break;
      case 'tool_use':
        // tool_use 不论流式与否都在 assistant 完成时推一次 —— 完整入参的权威
        // 快照（真流式 tool_input 只发抽出字段的增量，别的字段靠这条补全）
        ctx.emit(Events.deltaToolUse(ctx.counters.turns, block.id, block.name, block.input));
        ctx.incrementTool(false);

        // Phase 1：TodoWrite 工具单独再 emit 一条 todoUpdated。
        // SDK 不会在 type:'system' 里专门推 TodoWrite 状态 —— agent 用工具
        // 写计划时，input.todos 就是完整的 [{ content, status, activeForm }] 列表
        // （sdk-tools.d.ts:530 TodoWriteInput）。
        // tool_use 只够前端展示"调了 TodoWrite"，但拿不到结构化的 todo 列表给
        // 计划面板用，所以这里平行 emit 一次 run.todo.updated。
        if (block.name === 'TodoWrite' && block.input && Array.isArray(block.input.todos)) {
          ctx.emit(Events.todoUpdated(block.input.todos));
        }
        break;
      // 其他 block 类型（redacted_thinking / image / document）忽略
    }
  }
}

/**
 * C24：处理 SDK stream_event message（含 BetaRawMessageStreamEvent）。
 * 推逐 token 增量给前端实现打字效果。
 *
 * BetaRawMessageStreamEvent.type 值：
 *   message_start / content_block_start / content_block_delta /
 *   content_block_stop / message_delta / message_stop
 *
 * text_delta / thinking_delta 逐 token 转发；input_json_delta 只对 Edit/Write
 * 累积 + 节流抽字段（见下方"真流式工具入参"段），其余工具照旧等完整 block。
 */

// ── 真流式工具入参（2026-07-28，工作台舞台层代码直播）──
// input_json_delta 是半截 JSON 碎片，等拼完再发一次的话，模型逐 token 生成
// new_string 的几十秒里前端只能干转圈。这里对写代码的工具累积缓冲区，节流用
// partial-json 容错解析累积串，把目标字段相对上次的纯文本增量推给前端
// （run.delta.tool_input）。转义符跨块断开由解析器兜住；字段单调增长，
// 万一局部解析短暂回缩就跳过本拍（append 只在变长时发）。
const TOOL_INPUT_STREAM_FIELDS = {
  Edit: 'new_string',
  Write: 'content',
  // 板书直播（2026-08-25 流式路 A）：write_on_board 的 text 逐 token 流到画布上
  // 的舞台粉笔卡（StageLayer chalk 档）—— 粉笔字在用户眼前一行行长出来。
  mcp__nodesign__write_on_board: 'text',
  // board_batch 批内嵌套（08-25 用户报「流式名存实亡」：skill 教的是一章一次
  // batch，正文藏在 actions[].input.text 里，顶层字段抽取器抓不到 —— 等于亲手
  // 教了大家绕开流式）。batch 档抽**最新一条** write_on_board 动作的 text，
  // 换动作时发 reset 让前端另起一张。
  mcp__nodesign__board_batch: { batch: 'write_on_board', field: 'text' },
};
const TOOL_INPUT_THROTTLE_MS = 120;

function toolInputStreams(ctx) {
  if (!ctx._toolInputStreams) ctx._toolInputStreams = new Map();
  return ctx._toolInputStreams;
}


/** 批内嵌套抽取（纯函数好钉测试）：最新一条 <tool> 动作的 <field> 字符串与它的序号 */
export function latestBatchField(obj, toolName, field) {
  const actions = Array.isArray(obj?.actions) ? obj.actions : [];
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const a = actions[i];
    const name = String(a?.name || '');
    if ((name === toolName || name.endsWith(`__${toolName}`)) && typeof a?.input?.[field] === 'string') {
      return { idx: i, text: a.input[field] };
    }
  }
  return null;
}

function pumpToolInputStream(ctx, st, flush) {
  const now = Date.now();
  if (!flush && now - st.lastEmit < TOOL_INPUT_THROTTLE_MS) return;
  let obj;
  try { obj = parsePartialJson(st.buf, PartialAllow.ALL); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  let text = '';
  let reset = false;
  if (st.batch) {
    const hit = latestBatchField(obj, st.batch, st.field);
    if (hit) {
      if (st.actionIdx !== hit.idx) { st.actionIdx = hit.idx; st.sent = 0; reset = true; }
      text = hit.text;
    }
  } else {
    text = typeof obj[st.field] === 'string' ? obj[st.field] : '';
  }
  // file_path 只在确定流完后才取：容错解析会把半截字符串也带出来，第一拍常
  // 截在路径中间（e2e 撞过：抽到项目目录名 → 前端物件寻址指错）。目标字段的
  // key 出现（键序在 file_path 之后）或对象已有第二个键 = 路径已闭合。
  const pathComplete = obj[st.field] !== undefined || Object.keys(obj).length >= 2;
  // 发**工作区相对路径**（2026-08-13）：前端拿它当画布物件 id 的路径部分，
  // 而 id = 工作区相对路径。以前原样转发绝对路径，前端靠 `tasks/<任务>/`
  // 这个特征段抠相对部分 —— 那一层拆掉后绝对路径里没有可锚定的标志了。
  const rawFilePath = !st.filePathSent && pathComplete && typeof obj.file_path === 'string' ? obj.file_path : null;
  const filePath = rawFilePath ? toWorkspaceRel(rawFilePath, ctx.workspace?.root?.()) : null;
  const append = text.length > st.sent ? text.slice(st.sent) : '';
  if (!append && !filePath && !flush && !reset) return;
  st.lastEmit = now;
  if (append) st.sent = text.length;
  if (filePath) st.filePathSent = true;
  ctx.emit(Events.deltaToolInput(ctx.counters.turns, st.id, st.name, {
    ...(filePath ? { filePath } : {}),
    ...(append ? { append } : {}),
    ...(reset ? { reset: true } : {}),
    ...(flush ? { done: true } : {}),
  }));
}

function handleStreamEvent(ctx, msg) {
  const evt = msg.event;
  if (!evt) return;
  // 主线与子代理的 stream 可能并行交错，block index 各自归零 —— 加 parent 前缀区分
  const streamScope = msg.parent_tool_use_id || 'main';
  const streamKey = `${streamScope}:${evt.index}`;

  // 新 assistant message 开始 —— 该 scope 的 block index 归零，残留流式入参条目作废
  if (evt.type === 'message_start') {
    const streams = toolInputStreams(ctx);
    for (const key of [...streams.keys()]) {
      if (key.startsWith(`${streamScope}:`)) streams.delete(key);
    }
    return;
  }

  // tool_use 起点 —— content_block_start { content_block: { type: 'tool_use', id, name } }
  // 推 toolUseStarted 让前端立即显示 icon + tool name（status='running'）。
  // input 还没流完，等 assistant message 完成后 deltaToolUse 同 blockId update。
  // 体感：agent "想完→开干" 之间几乎没延迟，工具图标第一时间出现。
  if (evt.type === 'content_block_start') {
    const cb = evt.content_block;
    if (cb && cb.type === 'tool_use' && cb.id && cb.name) {
      ctx.emit(Events.toolUseStarted(ctx.counters.turns, cb.id, cb.name));
      const spec = TOOL_INPUT_STREAM_FIELDS[cb.name];
      if (spec && Number.isInteger(evt.index)) {
        const conf = typeof spec === 'string' ? { field: spec } : spec;
        toolInputStreams(ctx).set(streamKey, {
          id: cb.id, name: cb.name, field: conf.field, batch: conf.batch || null,
          actionIdx: -1, buf: '', sent: 0, lastEmit: 0, filePathSent: false,
        });
      }
    }
    return;
  }

  // 跟踪中的 tool_use block 收尾：最后一次 flush + 带 done 标记，清条目
  if (evt.type === 'content_block_stop') {
    const st = toolInputStreams(ctx).get(streamKey);
    if (st) {
      pumpToolInputStream(ctx, st, true);
      toolInputStreams(ctx).delete(streamKey);
    }
    return;
  }

  if (evt.type !== 'content_block_delta') return;

  const delta = evt.delta;
  if (!delta) return;

  if (delta.type === 'text_delta' && delta.text) {
    ctx.emit(Events.deltaText(ctx.counters.turns, delta.text));
  } else if (delta.type === 'thinking_delta' && delta.thinking) {
    ctx.emit(Events.deltaThinking(ctx.counters.turns, delta.thinking));
  } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    const st = toolInputStreams(ctx).get(streamKey);
    if (st) {
      st.buf += delta.partial_json;
      pumpToolInputStream(ctx, st, false);
    }
  }
  // signature_delta / citations_delta 暂不处理
}

function handleUserBlocks(ctx, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      const ok = !block.is_error;

      // C24：tool_result 的 content 可能是：
      //   - string（简单文本输出）
      //   - block[]（含 type:'text' / type:'image' 等多模态 content blocks）
      // P0 时把 image block JSON.stringify 序列化丢到文本里 → 前端显示
      // 一段难看的 base64 字符串。本提取分离：text 部分合并到 output，
      // image 部分单独传 images[] 数组让前端 <img src="data:..."> 渲染。
      let output = null;
      const images = [];

      if (typeof block.content === 'string') {
        output = block.content;
      } else if (Array.isArray(block.content)) {
        const textParts = [];
        for (const b of block.content) {
          if (b?.type === 'text' && b.text) {
            textParts.push(b.text);
          } else if (b?.type === 'image') {
            // 双格式兼容：
            //   - Anthropic content block: { type:'image', source:{ type:'base64', media_type, data } }
            //   - MCP CallToolResult ImageContent: { type:'image', data, mimeType }
            // SDK 透传 MCP CallToolResult 时格式不一定转换；只查 source.data 会漏接
            // generate_image 返的图，前端 chat 缩略图就空。
            const imgData = b.source?.data || b.data;
            const imgMime = b.source?.media_type || b.mimeType || 'image/png';
            if (imgData) {
              images.push({ mediaType: imgMime, data: imgData });
            } else {
              textParts.push(JSON.stringify(b));  // 拿不到 data 时留痕不丢数据
            }
          } else if (b) {
            // 未识别 block 类型 → fallback JSON.stringify 留痕（不丢数据）
            textParts.push(JSON.stringify(b));
          }
        }
        output = textParts.length > 0 ? textParts.join('\n') : null;
      }

      ctx.emit(Events.deltaToolResult(
        ctx.counters.turns,
        block.tool_use_id,
        '<sdk-tool>',                  // SDK 不在 tool_result 里带 name；前端可以从 tool_use 配对
        ok,
        ok ? output : undefined,
        ok ? undefined : { message: output || 'tool failed' },
        images.length > 0 ? images : undefined,
      ));
      if (!ok) ctx.counters.toolFailures += 1;
    }
  }
}

// ── 产物检测 ──

/**
 * 本轮的主产物是哪份（写进 run.metadata.artifactPath）。
 *
 * 2026-07-28 修：原来只探 cwd 根的四个候选文件名，而任务模型（2026-07-28 上线）
 * 把产物搬进了 `tasks/<任务>/`，于是这个函数**自任务模型上线起恒返 null** ——
 * artifactPath 一直是空的，没人发现，因为它不报错只是没值。
 */
export async function detectArtifact(ctx) {
  const root = typeof ctx?.workspace?.root === 'function' ? ctx.workspace.root() : null;
  if (root) {
    try {
      const artifacts = await listWorkspaceArtifacts(root);
      if (artifacts.length > 0) {
        // 扁平模型：没有"会话名下的任务"了，取第一份（列表序=收集器的
        // 稳定序）。老的 startsWith('tasks/') 优先级从扁平化起就是死代码。
        return artifacts[0].rel;
      }
    } catch { /* 扫不动就回落到旧式探测 */ }
  }
  for (const candidate of ARTIFACT_CANDIDATES) {
    if (await ctx.workspace.exists(candidate)) return candidate;
  }
  return null;
}
