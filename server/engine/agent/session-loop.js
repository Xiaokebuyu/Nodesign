/**
 * server/engine/agent/session-loop.js — Long-running query session loop
 *
 * SDK streamInput 模式：一个 SDK Query 持续吃 user message 跨多 turn，conversation
 * state 留在 SDK binary 内存里，**不依赖 jsonl resume**。
 *
 * 解决 per-turn query 架构的两个痛点：
 *   1. cancel 时 jsonl 残缺 → 下个 turn resume 失败丢上下文（streamInput 不 resume）
 *   2. 用户在 agent 跑时无法追加消息（streamInput 排队天然支持）
 *
 * 跟 loop.js runAgent 的关系：
 *   - 旧路径 runAgent 保留作 BC（probes / smoke / 部分 endpoint 走它）
 *   - 新路径 runSession 是主路（POST /turn 优先走它）
 *   - sdkOptions 构建大量 duplicate（Phase 4 cleanup 抽 shared helper）
 *
 * 主要不同点：
 *   - 不接 brief / userContentBlocks —— 用 inputQueue（AsyncQueue）作 prompt source
 *   - 不接 resumeSessionId —— streamInput 模式下 SDK 自己保 conversation state
 *   - per-turn lifecycle 管理：result message = turn 边界，emit run.done 但 query 不退
 *   - cancel 走 query.interrupt() —— SDK 出 result with terminal_reason='aborted_*'
 *     → 当前 turn emit run.cancelled → 继续等下条 user message
 *   - close session：inputQueue.close() → for-await-of 自然退出 → finally 清理
 *
 * 共享 ctx 策略（妥协）：
 *   一个 sharedCtx 横跨多 turn，每个 turn 边界处覆盖 runId + 重置 counters。
 *   这样 hooks / mcp 闭包持有的 ctx 引用稳定，emit 时 enrich 当前 turn runId。
 *   非 thread-safe（SDK stream 串行处理 message，OK）。
 *   Phase 4 cleanup 改成 ProxyContext 设计。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { AgentContext } from './context.js';
import { Events } from './events.js';
import { markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata } from '../runs/store.js';
import {
  registerQuerySession,
  attachSessionQuery,
  unregisterQuerySession,
  getCurrentTurnRunId,
  setCurrentTurnRunId,
  registerPendingQuestion,
} from '../runs/active-runs.js';
import { loadSkill } from './skill.js';
import { createHooks } from './hooks.js';
import { createNodesignMcpServer } from '../mcp/index.js';
import { createAgents } from '../agents/index.js';
import { getOrStartProxy } from '../../lib/binary-fixup-proxy.js';
import { AsyncQueue } from '../../lib/async-queue.js';
import {
  NODESIGN_PRELUDE,
  NODESIGN_PLAN_INSTRUCTIONS,
  DEFAULT_TOOL_ALLOWLIST,
  STREAMING_ENABLED,
  pickThinkingConfig,
  handleSDKMessage,
  detectArtifact,
} from './loop.js';

/**
 * 起一个 session-level long-running SDK query。runs 是 per-turn 概念（SDK 每见
 * 到一条 user message 起一轮 LLM 调用直到 stop_reason='end_turn'）。
 *
 * **必须**外部维护 inputQueue —— 调用方（turn.js）提前 push 第一条 message 后再
 * 调 runSession，session-loop 立即拉到处理。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.projectId
 * @param {string} opts.sessionWorkspaceRoot
 * @param {import('./events.js').EventBus} opts.eventBus
 * @param {import('../../lib/async-queue.js').AsyncQueue} opts.inputQueue
 * @param {string} [opts.skillId='deskskill-engine-mini']
 * @param {string} [opts.sessionTitle]
 * @param {object} [opts.modelOverride={}]
 * @param {string[]} [opts.toolAllowlist=DEFAULT_TOOL_ALLOWLIST]
 * @param {string} [opts.initialPermissionMode]
 * @param {string} [opts.initialRunId] - 首条 turn 的 run record id；若给则 register
 *                                       完立即设 currentRunId，避免 turn.js race
 *                                       condition（push 早于 register 没法关联 runId）
 * @returns {Promise<void>}  - inputQueue 关闭时 resolve
 */
export async function runSession({
  sessionId,
  projectId,
  sessionWorkspaceRoot,
  eventBus,
  inputQueue,
  skillId = 'deskskill-engine-mini',
  sessionTitle = null,
  modelOverride = {},
  toolAllowlist = DEFAULT_TOOL_ALLOWLIST,
  initialPermissionMode = null,
  initialRunId = null,
}) {
  if (!sessionId) throw new Error('runSession: sessionId required');
  if (!sessionWorkspaceRoot) throw new Error('runSession: sessionWorkspaceRoot required');
  if (!inputQueue || !(inputQueue instanceof AsyncQueue)) {
    throw new Error('runSession: inputQueue (AsyncQueue) required');
  }
  if (!eventBus) throw new Error('runSession: eventBus required');

  const cwdRoot = sessionWorkspaceRoot;
  const sharedRoot = projectId
    ? path.join(sessionWorkspaceRoot, '..', '..', 'shared')
    : null;

  const sessionAbortController = new AbortController();
  registerQuerySession(sessionId, {
    abortController: sessionAbortController,
    inputQueue,
  });
  // initialRunId：register 后立刻设 currentRunId，让 for-await-of 第一次见到
  // SDK 转发首条 user message 时直接知道当前 turn 的 runId（否则 turn.js 那边
  // 必须在 register 之后才能调 pushUserMessage —— race window）
  if (initialRunId) setCurrentTurnRunId(sessionId, initialRunId);

  // session-level start event（Phase 2，前端识别 query alive）
  eventBus.publish({ type: 'run.query.start', sessionId, ts: new Date().toISOString() });

  // sharedCtx：跨 turn 复用。每个 turn 边界覆盖 runId + 重置 counters。
  // hooks / mcp 闭包持稳定引用即可。
  const sharedCtx = new AgentContext({
    runId: '__session_pending__',
    skillId,
    eventBus,
    abortController: sessionAbortController,
    workspaceRoot: cwdRoot,
  });

  const wsRoot = await sharedCtx.workspace.ensure();
  const skill = await loadSkill(skillId);

  const model = modelOverride.model || process.env.NODESIGN_MODEL || 'kimi-k2.6';

  const realGatewayUrl = process.env.NODESIGN_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL;
  let baseUrlForBinary = realGatewayUrl;
  if (realGatewayUrl) {
    try {
      const proxy = await getOrStartProxy(realGatewayUrl);
      baseUrlForBinary = proxy.baseUrl;
    } catch (err) {
      console.warn(`[session-loop] proxy start failed, fallback direct: ${err.message}`);
    }
  }

  // 检测 jsonl 是否已存在 —— 决定走 resume（已存在）还是 sessionId（新建）
  // 之前的 bug：session-loop 永远传 sessionId，但如果用户 close session 后又
  // 用同 sid 起 query（hasActiveQuerySession=false 走 startNewRunSession），
  // SDK binary 看 jsonl 已存在抛 "Session ID ... is already in use"，
  // 子进程死，nodejs 端 stdin write EPIPE 整个 server 挂。
  const isResume = await jsonlExistsForSession(cwdRoot, sessionId);

  const sdkOptions = {
    cwd: cwdRoot,
    abortController: sessionAbortController,
    // 新建 → sessionId 让 SDK 用我们的 sid；已存在 → resume 续 jsonl 历史
    ...(isResume ? { resume: sessionId } : { sessionId }),
    // title 仅在新建时有效（resume 用持久化的 title）
    ...(sessionTitle && !isResume ? { title: sessionTitle.slice(0, 80) } : {}),
    ...(sharedRoot ? { additionalDirectories: [sharedRoot] } : {}),

    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrlForBinary,
      ANTHROPIC_API_KEY: process.env.NODESIGN_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
      CLAUDE_CONFIG_DIR: process.env.NODESIGN_CONFIG_DIR || path.join(cwdRoot, '.claude'),
      ...(model && /^kimi-k2\.6/i.test(model) ? {
        ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k2.5',
      } : {}),
    },

    model,
    tools: toolAllowlist,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [NODESIGN_PRELUDE, skill.systemPrompt].filter(Boolean).join('\n\n---\n\n'),
    },

    permissionMode: initialPermissionMode === 'plan' ? 'plan' : 'bypassPermissions',
    allowDangerouslySkipPermissions: initialPermissionMode !== 'plan',
    planModeInstructions: NODESIGN_PLAN_INSTRUCTIONS,

    // AskUserQuestion 拦截（同 loop.js）
    canUseTool: async (toolName, input, options) => {
      if (toolName !== 'AskUserQuestion') return { behavior: 'allow' };
      const toolUseId = options?.toolUseID;
      if (!toolUseId) {
        return { behavior: 'deny', message: 'AskUserQuestion missing toolUseID', interrupt: false };
      }
      const currentRunId = getCurrentTurnRunId(sessionId);
      if (!currentRunId) {
        return { behavior: 'deny', message: 'no active turn for AskUserQuestion', interrupt: false };
      }
      sharedCtx.emit({ type: 'run.ask_user_question', toolUseId, input });
      try {
        const answers = await registerPendingQuestion(currentRunId, toolUseId);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (err) {
        return { behavior: 'deny', message: err.message, interrupt: true };
      }
    },

    persistSession: true,
    settingSources: ['project'],
    includePartialMessages: STREAMING_ENABLED,

    thinking: modelOverride.thinking || pickThinkingConfig(model),
    effort: modelOverride.effort || 'medium',
    // streamInput 模式 query 横跨整个 session，maxTurns 是**全局累计**（每条
    // user message 起一轮 agent loop，turn 数不重置）。15 太低 —— 用户聊几
    // 轮就触顶导致 'error_max_turns' 误中断。改 50 给复杂 deck（多页 +
    // 多次自检 + 子代理）足够余量；env override 给极端情况用
    maxTurns: modelOverride.maxTurns
      || Number(process.env.NODESIGN_MAX_TURNS)
      || 50,

    // 不传 resume —— streamInput 模式 SDK 内存保 history，不依赖 jsonl
    enableFileCheckpointing: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    forwardSubagentText: true,

    // streamInput 模式 budget 也是全局累计 —— 长 session 1$ 极易触顶。改默
    // 认 5$（env override 仍生效）。Kimi 价位下 5$ 够跑很长一个 deck 项目；
    // Claude/Opus 烧得快可以用 env 提到 10
    maxBudgetUsd: (() => {
      const v = Number(process.env.NODESIGN_MAX_BUDGET_USD);
      return Number.isFinite(v) && v > 0 ? v : 5;
    })(),

    // Phase 3d 完整 sandbox（之前 streamInput 主路径漏配 filesystem，导致 agent
    // 写 ./.claude/agent-memory/brand/memory.md 等被默认拒，看似"写完消失"）
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      network: {
        allowLocalBinding: false,
        // MVP 阶段开放外网（'*' = 全域允许）—— 让 agent 能 curl 下载图/字体/音频
        // 到 ./assets/。生产可改成具体白名单（unsplash.com / fonts.googleapis.com
        // / cdn.jsdelivr.net / pixabay.com 等业务实际需要的）
        allowedDomains: ['*'],
      },
      filesystem: {
        allowWrite: [
          cwdRoot,
          ...(sharedRoot ? [
            path.join(sharedRoot, '.claude', 'agent-memory'),  // 跨 session memory
            path.join(sharedRoot, 'assets'),                    // 用户/agent 共写 ./assets/（软链 → shared）
          ] : []),
        ],
        denyWrite: ['/etc', '/usr', '/bin', '/sbin', '/private/etc'],
        denyRead: [
          '/etc/passwd', '/etc/shadow', '/etc/sudoers',
          path.join(os.homedir(), '.ssh'),
          path.join(os.homedir(), '.aws'),
          path.join(os.homedir(), '.gnupg'),
        ],
      },
    },

    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },

    hooks: createHooks({ ctx: sharedCtx, workspaceRoot: wsRoot }),

    mcpServers: {
      nodesign: createNodesignMcpServer({ workspaceRoot: wsRoot, ctx: sharedCtx }),
    },

    agents: createAgents(),

    stderr: (data) => {
      console.error(`[session ${sessionId.slice(0, 8)}/claude.stderr]`, data.trim());
    },
  };

  // ── per-turn lifecycle helpers ──

  let activeTurnRunId = null;

  const startTurn = (runId) => {
    activeTurnRunId = runId;
    // 重置 sharedCtx 的 per-turn state
    sharedCtx.runId = runId;
    sharedCtx.counters = {
      turns: 0, toolCalls: 0, toolFailures: 0,
      compactBoundaries: 0, apiRetries: 0,
      durationMs: 0, durationApiMs: 0, totalCostUsd: 0,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
    };
    sharedCtx.startedAt = Date.now();
    sharedCtx._cancelled = false;        // context.js cancel 幂等 flag 重置
    markRunStarted(runId);
    sharedCtx.emit(Events.start());
  };

  const finishTurn = async (status, info) => {
    if (!activeTurnRunId) return;
    const runId = activeTurnRunId;
    if (status === 'success') {
      const artifactPath = await detectArtifact(sharedCtx);
      mergeRunMetadata(runId, { sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters });
      try { markRunSucceeded(runId, { artifactPath }); } catch { /* idempotent */ }
      sharedCtx.emit(Events.done(info?.finalText || '', artifactPath, sharedCtx.snapshot ? sharedCtx.snapshot() : { counters: sharedCtx.counters }));
    } else if (status === 'cancelled') {
      mergeRunMetadata(runId, { aborted: true, abortReason: info?.reason || 'user_cancel' });
      try { markRunFailed(runId, `cancelled: ${info?.reason || 'user_cancel'}`); } catch { /* */ }
      sharedCtx.emit({ type: 'run.cancelled', reason: info?.reason || 'user_cancel' });
    } else if (status === 'error') {
      mergeRunMetadata(runId, {
        sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters,
        errorCode: info?.code, errorMessage: info?.message,
      });
      try { markRunFailed(runId, info?.message || 'unknown'); } catch { /* */ }
      sharedCtx.emit(Events.error(info?.message || 'unknown', info?.code, info?.stack));
    }
    activeTurnRunId = null;
    // 同步清 active-runs 的 currentRunId —— 否则 SDK 在 result 之后推的"尾巴
    // system message"（status / post_turn_summary 等）进 stream 时，cid 仍 = 已结束
    // 的老 runId 会触发 startTurn() 再调 markRunStarted() 抛"不在 pending 状态"
    setCurrentTurnRunId(sessionId, null);
  };

  // ── main stream loop ──

  let stream;
  try {
    stream = query({ prompt: inputQueue, options: sdkOptions });
    attachSessionQuery(sessionId, stream);

    // emitContextUsage：fire-and-forget per assistant message
    let usageInFlight = false;
    const emitContextUsage = () => {
      if (usageInFlight) return;
      usageInFlight = true;
      stream.getContextUsage()
        .then((usage) => { if (usage) sharedCtx.emit(Events.contextUsage(usage)); })
        .catch(() => { /* fail-soft */ })
        .finally(() => { usageInFlight = false; });
    };

    for await (const message of stream) {
      // 检测 turn 边界：currentRunId 切换 → 新 turn
      const cid = getCurrentTurnRunId(sessionId);
      if (cid && cid !== activeTurnRunId) {
        // 新 turn 开始（前一 turn 应该已 finishTurn — 防御性兜底）
        if (activeTurnRunId) {
          await finishTurn('error', { message: 'turn boundary skipped without result', code: 'TURN_LEAK' });
        }
        startTurn(cid);
      }

      handleSDKMessage(sharedCtx, message);

      if (message.type === 'assistant') emitContextUsage();

      if (message.type === 'result') {
        const isCancelled = message.terminal_reason === 'aborted_streaming'
          || message.terminal_reason === 'aborted_tools';

        if (isCancelled) {
          await finishTurn('cancelled', { reason: message.terminal_reason });
        } else if (message.subtype === 'success') {
          await finishTurn('success', { finalText: message.result || '' });
        } else {
          await finishTurn('error', {
            message: `agent run failed: ${message.subtype}`
              + (message.errors?.length ? ` — ${message.errors.join('; ')}` : ''),
            code: message.subtype,
          });
        }
        // turn 处理完 emit 当前 queue 积压（让前端"已排队 N 条"递减）
        eventBus.publish({
          type: 'run.queue.depth',
          sessionId,
          depth: inputQueue.size,
          ts: new Date().toISOString(),
        });
        // 不 throw —— query 继续等下一条 user message
      }
    }

    // for-await-of 自然结束（inputQueue.close 触发）→ session 完整收尾
    if (activeTurnRunId) {
      // input 关闭时还有 in-flight turn —— 当作 cancelled 收尾
      await finishTurn('cancelled', { reason: 'session_closed' });
    }
  } catch (err) {
    // 区分两种"抛错"：
    //   1. 用户主动 close session（abortController.abort() 触发 SDK binary
    //      子进程被 SIGTERM kill → 抛"Claude Code process aborted by user"）
    //      —— 这是预期行为，不是 error，不应该让前端弹"运行失败"toast
    //   2. 真错（网络断、SDK init 失败、Kimi gateway 5xx 等）—— 走 error 路径
    if (sessionAbortController.signal.aborted) {
      // close session 路径：当前 turn 当 cancelled 收尾，不 emit run.error
      if (activeTurnRunId) {
        await finishTurn('cancelled', {
          reason: sessionAbortController.signal.reason || 'session_closed',
        });
      }
      // 静默退出 —— finally 仍 emit run.query.end 让前端识别 session 关了
    } else {
      // 真错路径
      if (activeTurnRunId) {
        await finishTurn('error', err);
      }
      sharedCtx.emit(Events.error(err.message, err.code, err.stack));
      throw err;
    }
  } finally {
    unregisterQuerySession(sessionId);
    // session-level end event（Phase 2）
    try {
      eventBus.publish({
        type: 'run.query.end',
        sessionId,
        reason: sessionAbortController.signal.aborted
          ? (sessionAbortController.signal.reason || 'aborted')
          : 'closed',
        ts: new Date().toISOString(),
      });
    } catch { /* */ }
  }
}

/**
 * 检查给定 sessionId 是否已经有 SDK jsonl 落盘 —— 决定走 resume 还是新建。
 *
 * SDK 落盘路径：<sessionRoot>/.claude/projects/<encoded-cwd>/<sid>.jsonl
 * encoded-cwd 把 cwd 绝对路径里 '/' 换成 '-'。我们不复制 SDK 编码逻辑，
 * 直接遍历 .claude/projects/* 看哪个子目录里有 <sid>.jsonl。
 */
async function jsonlExistsForSession(sessionRoot, sessionId) {
  const projectsDir = path.join(sessionRoot, '.claude', 'projects');
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(projectsDir, e.name, `${sessionId}.jsonl`);
    try {
      await fs.access(f);
      return true;
    } catch { /* not here, try next */ }
  }
  return false;
}
