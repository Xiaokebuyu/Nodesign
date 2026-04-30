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
 * 跑一次 agent run。
 *
 * @param {object} opts
 * @param {string} opts.runId             - 已经 createRun 创建好的 run id（pending 状态）
 * @param {string} opts.skillId           - skill 名（loadSkill 解析）
 * @param {string} opts.brief             - 用户输入
 * @param {EventBus} [opts.eventBus]      - 事件总线（不传则 ctx 自建）
 * @param {AbortController} [opts.abortController]
 * @param {object} [opts.modelOverride]   - { model?, effort?, thinking?, maxTurns? }
 * @param {string[]} [opts.toolAllowlist] - 工具白名单 override（默认 DEFAULT_TOOL_ALLOWLIST）
 * @param {string} [opts.workspaceRoot]   - 外部 workspace 绝对路径（P0 per-project 目录）；
 *                                          不传则 fallback runId workspace（旧 smoke 行为）
 * @param {string} [opts.resumeSessionId] - SDK 续 session（同 project 跨 turn 用）
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

    stderr: (data) => {
      // 子进程 stderr → 调试日志（不入 EventBus 避免噪声）
      console.error(`[run ${runId}/claude.stderr]`, data.trim());
    },
  };

  // 4. 跑 query()
  let finalText = '';
  let artifactPath = null;

  try {
    const stream = query({
      prompt: brief,
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
 * SDKMessage union 见 sdk.d.ts:2988
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
      // 多种 subtype：compact_boundary / plugin_install / etc
      if (msg.subtype === 'compact_boundary') {
        ctx.counters.compactBoundaries += 1;
        ctx.emit({ type: 'run.compact_boundary', compactMetadata: msg.compact_metadata });
      }
      break;

    case 'stream_event':
      // 流增量（includePartialMessages: true 时）
      // 暂不细粒度推；用 assistant 完整 block 推一次足够
      break;

    case 'tool_use_summary':
      // 工具调用摘要事件，仅日志
      break;

    case 'status':
      // 'compacting' | 'requesting' | null
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

    case 'result':
      // 由外层 for await 捕获处理（finalText / artifactPath / counters）
      break;

    default:
      // 其他类型（hook lifecycle / task / notification 等）暂不处理
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
