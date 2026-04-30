/**
 * engine/agent/loop.js — Run orchestrator（包 SDK query()）
 *
 * 一次 run 的完整生命周期：
 *   1. 创建 AgentContext（含 EventBus + AbortController）
 *   2. 推 run.start 事件 + store 标记 running
 *   3. ensureWorkspace
 *   4. 加载 skill（systemPrompt）
 *   5. 调 SDK query()：cwd=workspace，env 透传 ANTHROPIC_BASE_URL+KEY，工具白名单
 *   6. 异步迭代 SDK message 流 → 翻译成 Nodesign EventBus 事件
 *   7. 处理 SDKResultMessage（success / error）
 *   8. 落 metadata + store 标记终态 + 推 run.done / run.error
 *
 * Gateway 路由：
 *   - 通过 options.env 透传 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY 给子进程
 *   - SDK 把这些环境变量原样喂给 spawn 的 claude binary
 *   - claude binary 把请求 POST 到 ANTHROPIC_BASE_URL/v1/messages
 *
 * 工具白名单（MVP）：
 *   Read / Write / Edit / Glob / Grep / TodoWrite
 *   Bash 暂不开（沙盒虽然 cwd 隔离了，但 shell 越界风险高）
 *   WebFetch / WebSearch 等到 P5 真做参考系统时再开
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentContext } from './context.js';
import { Events } from './events.js';
import { markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata } from '../runs/store.js';
import { loadSkill } from './skill.js';
import { createHooks } from './hooks.js';
import { createNodesignMcpServer } from '../mcp/index.js';

// 工具白名单 — Bash 是 P0 必需（agent 调 git/playwright/zip 都靠它）
// 沙盒由 cwd=project workspace 保证，git binary 通过 PATH 拿；agent 不能写
// JS 直接调 fs 越界，工具是唯一入口。
const DEFAULT_TOOL_ALLOWLIST = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash',
];

// 主产物候选 — canvas.html 列首位（P0 per-project workspace 主文件名），
// 其余兼容 deec72d 之前的 e2e smoke / 旧 deskskill-engine 输出。
const ARTIFACT_CANDIDATES = ['canvas.html', 'deck.html', 'index.html', 'output.html'];

/**
 * canUseTool 占位 callback —— P0+ stage 1 接 always-allow。
 *
 * 后续接 D 流权限交互时改成真处理：
 * - 弹前端 UI 让用户决定（accept once / always / deny）
 * - 根据 toolName + input 走不同策略（Bash 走白名单走 PreToolUse hook，Edit/Write 直接 allow）
 *
 * 现在 default permission mode 是 'default'，配合这个 always-allow 不会弹 CLI prompt。
 * Bash 等危险工具的拦截走 PreToolUse hook（C5 实现）。
 */
function makeAlwaysAllowCanUseTool() {
  return async (_toolName, _input, _options) => ({ behavior: 'allow' });
}

/**
 * 把 BetaContentBlockParam[] 包成 SDK 期望的 AsyncIterable<SDKUserMessage>。
 *
 * 单条 yield 后 iterator 自然结束 —— SDK 收到唯一一条 user message 后
 * 进入 agent loop。后续 turn 由前端再次调 POST /turn 触发新 query。
 *
 * 如果未来要做 streamInput 多轮复用（P0+ stage 2），这个 generator
 * 改成持续监听外部 push 的 message 队列，yield 的同时 iterator 不结束。
 */
async function* buildUserMessageStream(contentBlocks) {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks,
    },
    parent_tool_use_id: null,
  };
}

/**
 * 跑一次 agent run。
 *
 * @param {object} opts
 * @param {string} opts.runId             - 已经 createRun 创建好的 run id（pending 状态）
 * @param {string} opts.skillId           - skill 名（loadSkill 解析）
 * @param {string} opts.brief             - 用户输入（文本）；当 userContentBlocks 缺省时
 *                                          会被包成单个 text content block 走 SDK
 * @param {EventBus} [opts.eventBus]      - 事件总线（不传则 ctx 自建）
 * @param {AbortController} [opts.abortController]
 * @param {object} [opts.modelOverride]   - { model?, effort?, thinking?, maxTurns? }
 * @param {string[]} [opts.toolAllowlist] - 工具白名单 override（默认 DEFAULT_TOOL_ALLOWLIST）
 * @param {string} [opts.workspaceRoot]   - 外部 workspace 绝对路径（P0 per-project 目录）；
 *                                          不传则 fallback runId workspace（旧 smoke 行为）
 * @param {string} [opts.resumeSessionId] - SDK 续 session（同 project 跨 turn 用）
 * @param {Array} [opts.userContentBlocks] - SDK BetaContentBlockParam[]（C2 多模态接口）；
 *                                          传入时走 prompt: AsyncIterable<SDKUserMessage> 流，
 *                                          不传则 fallback brief 文本（旧 string 接口）
 *
 * @returns {Promise<{ finalText, artifactPath, snapshot }>}
 */
export async function runAgent({
  runId,
  skillId,
  brief,
  eventBus,
  abortController,
  modelOverride = {},
  toolAllowlist = DEFAULT_TOOL_ALLOWLIST,
  workspaceRoot = null,
  resumeSessionId = null,
  userContentBlocks = null,
}) {
  if (!runId) throw new Error('runAgent: runId required');
  if (!skillId) throw new Error('runAgent: skillId required');
  if (!brief) throw new Error('runAgent: brief required');

  const ctx = new AgentContext({ runId, skillId, eventBus, abortController, workspaceRoot });

  // 1. 进 running 状态 + 推开始事件
  markRunStarted(runId);
  ctx.emit(Events.start());

  // 2. 准备 workspace + skill
  // ctx.workspace.ensure() 内部判断：外部 workspaceRoot 模式直接 mkdir + 返回；
  // 旧 runId 模式走 runtime/workspace.js。
  const wsRoot = await ctx.workspace.ensure();
  const skill = await loadSkill(skillId);

  // 3. 拼 SDK options
  const sdkOptions = {
    cwd: wsRoot,
    abortController: ctx.abortController,

    // 关键：env 透传给子进程，让 claude binary 走 Nodesign gateway
    env: {
      ...process.env,                                                  // 透传基础 env
      ANTHROPIC_BASE_URL: process.env.NODESIGN_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_API_KEY: process.env.NODESIGN_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
    },

    model: modelOverride.model || process.env.NODESIGN_MODEL || 'kimi-k2.6',

    // 工具白名单
    tools: toolAllowlist,
    allowedTools: toolAllowlist,    // 同时白名单，避免每次问权限

    // 自定义 systemPrompt（不用 claude_code preset）
    systemPrompt: skill.systemPrompt,

    // 不读外部 settings 文件 / 不写 session 文件
    persistSession: false,
    settingSources: [],

    // 流增量（用于细粒度推 WS）
    includePartialMessages: true,

    // thinking + effort
    thinking: modelOverride.thinking || { type: 'adaptive' },
    effort: modelOverride.effort || 'medium',

    maxTurns: modelOverride.maxTurns || 50,

    // 续 session：同 project 跨 turn 时传入上次 sessionId，prompt cache 自然命中
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),

    // ── P0+ stage 1 新增 ──
    // file checkpoint：开后 SDK 在每个 user message 处快照文件状态，
    // Query.rewindFiles(userMessageId) 可以回滚。session 内 undo 走这条
    // （C12 接前端 Undo button）；跨 session 长期追溯仍依赖 git commit。
    enableFileCheckpointing: true,

    // subagent 30s 进度摘要 —— 子代理跑 vision-checker / ds-extractor
    // 等长任务时，每 30s 由 SDK 自动 fork 子 session 产出"正在 X"摘要事件。
    // piggyback 父 prompt cache，几乎免费。
    agentProgressSummaries: true,

    // 每轮后预测下条 user prompt —— 前端 SuggestionChip 用（C19）。
    // 第一轮、API error、plan mode 下不发；piggyback 父 prompt cache 几乎免费。
    promptSuggestions: true,

    // 自定义权限处理器 —— 现在占位 always-allow，Bash 危险命令拦截走
    // PreToolUse hook（C5）。D 流定型后改成真 UI 弹窗。
    canUseTool: makeAlwaysAllowCanUseTool(),

    // hooks 4 件套（C3 骨架，C4-C7 逐个填实）：
    // FileChanged / PreToolUse(Bash) / Stop / PostCompact
    hooks: createHooks({ ctx, workspaceRoot: wsRoot }),

    // C8 自定义 MCP 工具集（in-process）：
    // - mcp__nodesign__ping（占位）
    // - C9 mcp__nodesign__screenshot_canvas
    // - C10 mcp__nodesign__export_handoff
    // - C11 mcp__nodesign__record_decision
    mcpServers: {
      nodesign: createNodesignMcpServer({ workspaceRoot: wsRoot, ctx }),
    },

    stderr: (data) => {
      // 子进程 stderr → 调试日志（不入 EventBus 避免噪声）
      console.error(`[run ${runId}/claude.stderr]`, data.trim());
    },
  };

  // 4. 跑 query()
  let finalText = '';
  let artifactPath = null;

  // prompt 包装：
  // - 有 userContentBlocks → 走 SDK 多模态流式接口（AsyncIterable<SDKUserMessage>）
  //   一次性 yield 一条 user message，iterator 关闭 → SDK 进 agent loop。
  // - 没有 → fallback 直接传 brief 字符串（兼容旧 smoke 路径）
  const promptInput = userContentBlocks && Array.isArray(userContentBlocks) && userContentBlocks.length > 0
    ? buildUserMessageStream(userContentBlocks)
    : brief;

  try {
    const stream = query({
      prompt: promptInput,
      options: sdkOptions,
    });

    for await (const message of stream) {
      ctx.ensureNotAborted();
      handleSDKMessage(ctx, message);

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalText = message.result || '';
          ctx.absorbResult(message);
          artifactPath = await detectArtifact(ctx);
        } else {
          // SDK 自身返回 error result（max_turns / max_budget / structured_output_retries / execution）
          ctx.absorbResult(message);
          const errMsg = `agent run failed: ${message.subtype}`
            + (message.errors?.length ? ` — ${message.errors.join('; ')}` : '');
          const err = new Error(errMsg);
          err.code = message.subtype;
          throw err;
        }
      }
    }

    // 5. 落 metadata + 标记成功
    mergeRunMetadata(runId, {
      sdkSessionId: ctx.sdkSessionId,
      ...ctx.counters,
    });
    markRunSucceeded(runId, { artifactPath });
    ctx.emit(Events.done(finalText, artifactPath, ctx.snapshot()));

    return { finalText, artifactPath, snapshot: ctx.snapshot() };

  } catch (err) {
    // 区分用户取消 vs 真错
    if (ctx.signal.aborted) {
      mergeRunMetadata(runId, { aborted: true, abortReason: ctx.signal.reason || 'unknown' });
      try { markRunFailed(runId, `cancelled: ${ctx.signal.reason || 'user_cancel'}`); } catch { /* state may have moved */ }
      // run.cancelled 在 ctx.cancel() 时已推
    } else {
      mergeRunMetadata(runId, {
        sdkSessionId: ctx.sdkSessionId,
        ...ctx.counters,
        errorCode: err.code,
        errorMessage: err.message,
      });
      try { markRunFailed(runId, err.message); } catch { /* idempotent */ }
      ctx.emit(Events.error(err.message, err.code, err.stack));
    }
    throw err;
  }
}

// ── SDK message → EventBus 翻译层 ──

/**
 * 把 SDK 各种 message 类型翻译成 Nodesign 内部事件。
 * SDKMessage union 见 sdk.d.ts:2988（28+ 种 type/subtype 组合）。
 *
 * 翻译策略：
 * - 主流程消息（assistant / user / result）：走 handleAssistantBlocks / handleUserBlocks
 * - SDK system subtype 多达 14 种：分派到对应 Events 构造器
 * - 旁路类型（stream_event / tool_use_summary / keep_alive）：noop（前端不需要）
 */
function handleSDKMessage(ctx, msg) {
  // 首条 message 含 session_id，记下
  if (msg.session_id) ctx.recordSdkSession(msg.session_id);

  switch (msg.type) {
    case 'assistant':
      // BetaMessage 含 content[] (text / thinking / tool_use blocks)
      handleAssistantBlocks(ctx, msg.message?.content || []);
      break;

    case 'user':
      // 一般是 tool_result 反馈（agent loop 中 SDK 会回填）
      handleUserBlocks(ctx, msg.message?.content || []);
      break;

    case 'system':
      handleSystemMessage(ctx, msg);
      break;

    case 'stream_event':
      // SDKPartialAssistantMessage —— 流增量（includePartialMessages: true 时）
      // 不细粒度推；assistant 整块 block 推一次足够。前端不依赖。
      break;

    case 'tool_use_summary':
      // SDKToolUseSummaryMessage —— 工具调用摘要（旁路审计），不入 EventBus
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
      ctx.emit(Events.systemInit({
        agents: msg.agents,
        tools: msg.tools,
        mcpServers: msg.mcp_servers,
        model: msg.model,
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
      ctx.emit(Events.taskStarted(msg.task_id, msg.description, msg.task_type, msg.prompt));
      break;

    case 'task_progress':
      // agentProgressSummaries: true 时每 ~30s 一次："正在调整字号节奏" 之类
      ctx.emit(Events.taskProgress(
        msg.task_id, msg.description, msg.summary, msg.last_tool_name, msg.usage,
      ));
      break;

    case 'task_updated':
      ctx.emit(Events.taskUpdated(msg.task_id, msg.patch));
      break;

    case 'task_notification':
      ctx.emit(Events.taskNotification(msg.task_id, msg.status, msg.summary, msg.usage));
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

    default:
      console.warn(`[run ${ctx.runId}] unknown system subtype:`, msg.subtype);
      break;
  }
}

function handleAssistantBlocks(ctx, content) {
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) ctx.emit(Events.deltaText(ctx.counters.turns, block.text));
        break;
      case 'thinking':
        if (block.thinking) ctx.emit(Events.deltaThinking(ctx.counters.turns, block.thinking));
        break;
      case 'tool_use':
        ctx.emit(Events.deltaToolUse(ctx.counters.turns, block.id, block.name, block.input));
        ctx.incrementTool(false);
        break;
      // 其他 block 类型（redacted_thinking / image / document）忽略
    }
  }
}

function handleUserBlocks(ctx, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      const ok = !block.is_error;
      // tool_result 的 content 可能是 string 或 block[]
      const output = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map(b => b.text || JSON.stringify(b)).join('\n')
          : null;
      ctx.emit(Events.deltaToolResult(
        ctx.counters.turns,
        block.tool_use_id,
        '<sdk-tool>',                  // SDK 不在 tool_result 里带 name；前端可以从 tool_use 配对
        ok,
        ok ? output : undefined,
        ok ? undefined : { message: output || 'tool failed' }
      ));
      if (!ok) ctx.counters.toolFailures += 1;
    }
  }
}

// ── 产物检测 ──

async function detectArtifact(ctx) {
  for (const candidate of ARTIFACT_CANDIDATES) {
    if (await ctx.workspace.exists(candidate)) return candidate;
  }
  return null;
}
