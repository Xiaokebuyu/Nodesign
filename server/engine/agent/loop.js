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

import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentContext } from './context.js';
import { Events } from './events.js';
import { markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata } from '../runs/store.js';
import { registerRun, attachQuery, unregisterRun } from '../runs/active-runs.js';
import { loadSkill } from './skill.js';
import { createHooks } from './hooks.js';
import { createNodesignMcpServer } from '../mcp/index.js';
import { createAgents } from '../agents/index.js';

// 工具白名单 — Bash 是 P0 必需（agent 调 git/playwright/zip 都靠它）。
// 沙盒由 cwd=project workspace 保证 + PreToolUse hook 命令白名单兜底。
//
// AskUserQuestion 在白名单 —— permissionMode='bypassPermissions' 后 binary
// 跳过 stdio prompt，AskUserQuestion 走正常 tool_use → 前端 AskUserQuestionView
// 渲染卡片 → 用户点选项 → setChatDraft → 用户 send 新 turn → agent 看到答案
const DEFAULT_TOOL_ALLOWLIST = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash',
  'AskUserQuestion',
];

// 主产物候选 — canvas.html 列首位（P0 per-project workspace 主文件名），
// 其余兼容 deec72d 之前的 e2e smoke / 旧 deskskill-engine 输出。
const ARTIFACT_CANDIDATES = ['canvas.html', 'deck.html', 'index.html', 'output.html'];

// P0+ s1 C24：流式打字效果（text / thinking 逐 token 推送）。
// 跟 sdkOptions.includePartialMessages 同步 —— 我们默认开（前端要打字效果）。
// 启用时 handleAssistantBlocks 跳过 text/thinking blocks（已经从 stream_event 推完，
// 避免双推），但仍推 tool_use（stream_event 里 tool_use input 是 partial JSON delta
// 不好用，等 assistant message 完整 block 来一次更省事）。
const STREAMING_ENABLED = true;

// canUseTool 已撤（hotfix-sdk-usage）：实测发现 canUseTool always-allow
// 不能阻止 binary 子进程内部走 stdio prompt（permissionMode='default' 默认
// 会 prompt for dangerous operations，spawn 没接 stdin → hang）。
// 改用 permissionMode: 'bypassPermissions' + allowDangerouslySkipPermissions
// 跳过所有 permission 检查；危险命令拦截走 PreToolUse hook（C5 Bash 白名单）。
// stage 2 接 D 流权限交互时改成真处理（前端 UI 弹窗）。

/**
 * 把 BetaContentBlockParam[] 或 string brief 包成 SDK 期望的
 * AsyncIterable<SDKUserMessage>。
 *
 * 单条 yield 后 iterator 自然结束 —— SDK 收到唯一一条 user message 后
 * 进入 agent loop。后续 turn 由前端再次调 POST /turn 触发新 query。
 *
 * **为什么 Phase 1 强制走 AsyncIterable**：
 *   SDK Query 上的 control 方法（interrupt / setModel / setPermissionMode /
 *   getContextUsage / mcpServerStatus / rewindFiles / streamInput / stopTask /
 *   toggleMcpServer / ...）**只在 streaming input/output 模式下可用**
 *   （sdk.d.ts:2018-2022）。直接传 prompt: string 不是 streaming，control
 *   方法对那条路径无效。统一包成 AsyncIterable 让所有 run 都能拿到完整
 *   控制能力。
 *
 * 如果未来要做 streamInput 多轮复用（让一个 query handle 跨多个 user
 * message），这个 generator 改成持续监听外部 push 的 message 队列，
 * yield 的同时 iterator 不结束。
 *
 * @param {Array<object> | string} contentOrBrief - content blocks 数组或纯文本 brief
 */
async function* buildUserMessageStream(contentOrBrief) {
  const content = typeof contentOrBrief === 'string'
    ? [{ type: 'text', text: contentOrBrief }]
    : contentOrBrief;
  yield {
    type: 'user',
    message: {
      role: 'user',
      content,
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

  // 注册到 active-runs registry，让 cancel endpoint 能控制本 run。
  // 此时只有 abortController + ctx（query 还没调），后面拿到 query handle 再 attachQuery。
  // ctx 必传：cancelRun 走 ctx.cancel() 统一 emit run.cancelled，避免 abort
  // 路径下前端永远卡 streaming（Phase 1 遗留 bug）。
  // finally 块 unregister 避免泄漏。
  registerRun(runId, { abortController: ctx.abortController, ctx });

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
      // S1：per-project session/config 隔离 —— SDK binary 子进程把 JSONL 转录、
      // settings、agents 等都落到 <workspace>/.claude/ 下（默认是 ~/.claude/）。
      // 项目自包含：删项目 = 删整个 workspace 目录（含 session 历史）。
      // 多 project 并发零冲突（每次 query 独立 spawn，env 不共享）。
      // NODESIGN_CONFIG_DIR env 可全局覆盖（生产容器统一持久化卷场景）。
      // 不直接读 process.env.CLAUDE_CONFIG_DIR — 那是给子进程的目标变量，
      // 开发机若设了会让所有 project 共享同一目录，破坏隔离。
      CLAUDE_CONFIG_DIR: process.env.NODESIGN_CONFIG_DIR || path.join(wsRoot, '.claude'),
    },

    model: modelOverride.model || process.env.NODESIGN_MODEL || 'kimi-k2.6',

    // 工具白名单
    tools: toolAllowlist,
    allowedTools: toolAllowlist,    // 同时白名单，避免每次问权限

    // hotfix-sdk-usage：systemPrompt 改 preset 'claude_code' + append。
    // 之前用 string 完全替换 SDK 默认 prompt → 失去 Claude Code 的关键
    // 行为约束（何时停 / be concise / task completion 信号 / 工具最佳实践），
    // 导致 agent 一个 turn 做 30+ 件事停不下来。
    // 现在继承 preset + 把 SKILL.md 业务约束 append 在后。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: skill.systemPrompt,
    },

    // hotfix-sdk-usage：跳过所有 permission 检查。
    // 默认 permissionMode 'default' 会 prompt for dangerous operations，
    // binary 子进程通过 stdio prompt → spawn 没接 stdin → hang（"ask 不
    // pending"症状的根因）。canUseTool always-allow 不能 override 这个。
    // 危险命令拦截已经走 PreToolUse hook（C5 Bash 白名单），bypass 安全。
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,

    // S1：开 SDK 自带 session 持久化 + 项目级配置加载
    //   persistSession: true → SDK 写 JSONL 到 CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl
    //   settingSources: ['project'] → SDK 自动加载 <workspace>/.claude/CLAUDE.md
    //     （项目 instruction，append 到 system prompt）+ .claude/settings.json
    //     （项目级 hooks/permissions/model override，与 query options 合并，options 优先）
    //   resume: <sid>（下方 spread）→ 真生效（之前 persistSession=false 导致 resume 假装跑）
    persistSession: true,
    settingSources: ['project'],

    // 流增量（用于细粒度推 WS）
    includePartialMessages: true,

    // thinking + effort
    thinking: modelOverride.thinking || { type: 'adaptive' },
    effort: modelOverride.effort || 'medium',

    // hotfix-sdk-usage：50 太宽，agent 一个 turn 能做 30+ 件事（写文件 /
    // 截图 / record_decision / 反复优化），用户感觉"停不下来"。
    // 15 够做完一个 canvas + 1-2 次自检；做不完应该收尾让用户反馈。
    maxTurns: modelOverride.maxTurns || 15,

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

    // ── Phase 3a：SDK 高级 options ──
    // 子代理 thinking/text 转发到主流（带 parent_tool_use_id）。当前 stage 1
    // 子代理还没主动调用，但开关本身零成本：开了之后任何子代理调用（包括用户
    // 手动让 agent Task）都立刻有 thinking/text 转发到前端 chat，便于
    // 子代理可观测性。Phase 4 子代理真接通时直接生效。
    forwardSubagentText: true,

    // 成本预算上限（USD）—— 防 agent 烧成本失控（KIMI / Claude 价位差大，
    // 一个失控的 turn 可能 > $5）。默认 $1，env NODESIGN_MAX_BUDGET_USD 可
    // override。SDK 会在跑到上限时返回 SDKResultMessage subtype:'error_max_budget_usd'，
    // 已被 loop.js 现有 result 处理捕获 → markRunFailed → emit run.error。
    //
    // clamp 行为：env 解析失败（NaN）/ 0 / 负数 一律 fallback 到默认 $1，
    // 防止用户 typo（如 NODESIGN_MAX_BUDGET_USD=-5）pass through 到 SDK
    // 触发未文档化行为。
    maxBudgetUsd: (() => {
      const v = Number(process.env.NODESIGN_MAX_BUDGET_USD);
      return Number.isFinite(v) && v > 0 ? v : 1;
    })(),

    // additionalDirectories: 跳过（无硬场景，每个 project workspace 是独立的）
    // outputFormat: 跳过（强制 main agent JSON 输出违反自然对话设计）

    // ── Phase 3d：SDK 内置 sandbox 替换 PreToolUse Bash 白名单 ──
    // SDK SandboxSettings 是 OS 级隔离（macOS sandbox-exec / Linux bubblewrap）。
    // 替换原 hooks.js 的正则 ALLOWED_FIRST_TOKEN + DANGEROUS_PATTERNS（命令级 deny）。
    //
    // d.ts 未明确：sandbox 是否拦 Bash 子进程 spawn 出去的命令（curl/wget/sudo
    // 这种命令级危险）。autoAllowBashIfSandboxed 字段名暗示 sandbox 知道 Bash
    // 但行为不明。真跑 smoke 验证后如发现 sandbox 不拦命令级危险，回滚 hooks.js
    // 的删除（git revert 3d.2 commit），sandbox 部分保留（filesystem 限制仍有价值）。
    //
    // 用户决策：failIfUnavailable: true —— 不静默降级。开发机不支持 sandbox 时
    // NoDesign 直接拒绝跑（macOS sandbox-exec 通常可用 / Linux 需要 bubblewrap）。
    sandbox: {
      enabled: true,
      failIfUnavailable: true,

      // 网络：暂不 deny 所有外网 —— claude binary 子进程要联 NODESIGN_GATEWAY_URL
      // （anthropic gateway），太激进会让 SDK 自己挂。仅在 NoDesign 业务上明确不
      // 需要的子进程外网才用。当前只声明 SDK WebFetch/WebSearch 的限制（这两个
      // 工具不在白名单 → SDK 不调）+ 禁止本地 socket 绑定（防 agent 起内部服务）。
      network: {
        allowLocalBinding: false,
      },

      // 文件系统：核心隔离层
      // - allowWrite: 仅允许写 project workspace（cwd），其他位置 SDK 工具 deny
      // - denyWrite: 系统目录硬封（即便 allowWrite 误配也兜底）
      // - denyRead: /etc/* 系统凭据 + ~/.ssh / ~/.aws 用户凭据。
      //   d.ts 没说支持 ~ 展开，所以用 os.homedir() 展成绝对路径喂给 sandbox。
      filesystem: {
        allowWrite: [wsRoot],
        denyWrite: ['/etc', '/usr', '/bin', '/sbin', '/private/etc'],
        denyRead: [
          '/etc/passwd', '/etc/shadow', '/etc/sudoers',
          path.join(os.homedir(), '.ssh'),
          path.join(os.homedir(), '.aws'),
          path.join(os.homedir(), '.gnupg'),
        ],
      },
    },

    // canUseTool 已撤（hotfix-sdk-usage）—— 见 permissionMode: 'bypassPermissions' 注释

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

    // C13 子代理定义（vision-checker / ds-extractor / tweak-proposer）
    // 这次只挂骨架；main agent 通过 SKILL.md 引导不主动调，stage 2 接通流程
    agents: createAgents(),

    stderr: (data) => {
      // 子进程 stderr → 调试日志（不入 EventBus 避免噪声）
      console.error(`[run ${runId}/claude.stderr]`, data.trim());
    },
  };

  // 4. 跑 query()
  let finalText = '';
  let artifactPath = null;

  // prompt 包装：统一走 AsyncIterable<SDKUserMessage>（streaming 模式）。
  // 这样 SDK Query 上的 control 方法（interrupt/setModel/rewindFiles/...）
  // 对所有 run 都可用 —— sdk.d.ts:2018-2022 明确说明 control requests
  // 只在 streaming input/output 模式下可用。
  // - 有 userContentBlocks → buildUserMessageStream 直接包
  // - 没有 → 把 brief 字符串包成 [{ type: 'text', text: brief }] 也走 streaming
  const promptInput = userContentBlocks && Array.isArray(userContentBlocks) && userContentBlocks.length > 0
    ? buildUserMessageStream(userContentBlocks)
    : buildUserMessageStream(brief);

  try {
    // S1：resume 兜底 fallback。store.js 启动时已一次性清洗老 active_session_id
    //（原 persistSession=false 时 setActiveSession 写入的 sid 全部无效），
    // 但仍可能漏网（手工 INSERT、未来回归）。query() 抛 resume 相关错误时
    // 重跑一次去掉 resume，避免整个 turn 因为一个失效 sid 直接挂掉。
    let stream;
    try {
      stream = query({ prompt: promptInput, options: sdkOptions });
    } catch (initErr) {
      const msg = String(initErr?.message || '');
      if (resumeSessionId && /resume|session.*not.*found|no.*such.*session/i.test(msg)) {
        console.warn(`[run ${runId}] resume failed (${resumeSessionId.slice(0, 8)}…), retrying without resume:`, msg);
        ctx.emit({ type: 'run.resume_failed_fallback', reason: msg, staleSessionId: resumeSessionId });
        const { resume: _drop, ...rest } = sdkOptions;
        stream = query({ prompt: promptInput, options: rest });
      } else {
        throw initErr;
      }
    }

    // query() 返回的就是 Query handle（继承 AsyncGenerator<SDKMessage, void>）。
    // 立即把它 attach 到 active-runs，让上层 endpoint 能调
    // interrupt/setModel/rewindFiles/getContextUsage/mcpServerStatus/...
    // 在 attachQuery 之前的窗口里，cancelRun 会 fallback 到 abortController.abort。
    attachQuery(runId, stream);

    for await (const message of stream) {
      ctx.ensureNotAborted();
      handleSDKMessage(ctx, message);

      if (message.type === 'result') {
        // Phase 3c：先识别 cancellation。query.interrupt() 让 SDK 自然结束时
        // SDKResultMessage 可能 subtype='success' 但 terminal_reason='aborted_*'
        // （sdk.d.ts:5339 'aborted_streaming' | 'aborted_tools'）。在 success/error
        // 分派之前优先识别这条路径，否则会被当作正常完成 emit run.done。
        //
        // d.ts 未明确 interrupt 触发哪个 terminal_reason，两个值都覆盖。
        // ctx.signal.aborted 兜底（cancelRun 走 ctx.cancel() 设了 abort 也算）。
        const isCancelled = ctx.signal.aborted
          || message.terminal_reason === 'aborted_streaming'
          || message.terminal_reason === 'aborted_tools';

        if (isCancelled) {
          ctx.absorbResult(message);
          // ctx.cancel() 幂等：
          // - interrupt 路径走到这里时 ctx.signal.aborted 可能还是 false
          //   （interrupt 不直接触发 abort）→ ctx.cancel() set abort + emit run.cancelled
          // - abort 路径（race / 5s 兜底）走到这里时 cancelRun 已经调过 ctx.cancel()
          //   → context.js._cancelled=true noop，不会双 emit
          ctx.cancel(ctx.signal.reason || 'user_interrupt');
          const err = new Error(`run cancelled: ${message.terminal_reason || ctx.signal.reason || 'aborted'}`);
          err.code = 'AGENT_CANCELLED';
          throw err;
        }

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
      // Phase 3c：run.cancelled 已由 ctx.cancel() emit（幂等保证恰好一次）—— 三条路径覆盖：
      //   1. cancelRun race window → cancelRun 直接调 ctx.cancel()
      //   2. cancelRun → query.interrupt() → result 'aborted_*' → ctx.cancel()
      //   3. cancelRun → 5s 兜底 → cancelViaCtxOrAbort → ctx.cancel()
      // 之前 Phase 1 这条注释是错的（实际没人调 ctx.cancel()），导致前端永远卡 streaming。
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
  } finally {
    // 不论 succeeded / failed / cancelled，从 registry 注销 controller
    // 防止 in-memory map 泄漏（也防 cancel endpoint 拿到已死 controller）
    unregisterRun(runId);
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
      // STREAMING_ENABLED 时 text/thinking 已从 stream_event 推完，跳过避免双推
      handleAssistantBlocks(ctx, msg.message?.content || [], STREAMING_ENABLED);
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
      ctx.emit(Events.taskStarted(
        msg.task_id, msg.description, msg.task_type, msg.prompt, msg.tool_use_id,
      ));
      break;

    case 'task_progress':
      // agentProgressSummaries: true 时每 ~30s 一次："正在调整字号节奏" 之类
      ctx.emit(Events.taskProgress(
        msg.task_id, msg.description, msg.summary, msg.last_tool_name, msg.usage, msg.tool_use_id,
      ));
      break;

    case 'task_updated':
      ctx.emit(Events.taskUpdated(msg.task_id, msg.patch, msg.tool_use_id));
      break;

    case 'task_notification':
      ctx.emit(Events.taskNotification(
        msg.task_id, msg.status, msg.summary, msg.usage, msg.tool_use_id,
      ));
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
        // tool_use 不论流式与否都在 assistant 完成时推一次（SDK stream_event
        // 里 tool_use input 是 partial JSON delta，前端拼起来不划算）
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
 * 我们只关心 content_block_delta（含 text_delta / thinking_delta /
 * input_json_delta / signature_delta / citations_delta）。
 * input_json_delta 不处理（tool_use input 等完整 block 在 assistant message 里推）。
 */
function handleStreamEvent(ctx, msg) {
  const evt = msg.event;
  if (!evt || evt.type !== 'content_block_delta') return;

  const delta = evt.delta;
  if (!delta) return;

  if (delta.type === 'text_delta' && delta.text) {
    ctx.emit(Events.deltaText(ctx.counters.turns, delta.text));
  } else if (delta.type === 'thinking_delta' && delta.thinking) {
    ctx.emit(Events.deltaThinking(ctx.counters.turns, delta.thinking));
  }
  // input_json_delta / signature_delta / citations_delta 暂不处理
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
          } else if (b?.type === 'image' && b.source?.data) {
            images.push({
              mediaType: b.source.media_type || 'image/png',
              data: b.source.data,
            });
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

async function detectArtifact(ctx) {
  for (const candidate of ARTIFACT_CANDIDATES) {
    if (await ctx.workspace.exists(candidate)) return candidate;
  }
  return null;
}
