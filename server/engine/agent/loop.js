/**
 * engine/agent/loop.js — Run orchestrator（包 SDK query()）
 *
 * 一次 run 的完整生命周期：
*   1. 创建 AgentContext（含 EventBus + AbortController）
 *   2. 推 run.start 事件 + store 标记 running
 *   3. ensureWorkspace
 *   4. 加载 skill（业务 systemPrompt）—— 注意通用 prelude 走模块级 NODESIGN_PRELUDE
 *      不每次重读；最终 systemPrompt 拼接：preset 'claude_code' + prelude + skill body
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
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentContext } from './context.js';
import { Events } from './events.js';
import { markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata } from '../runs/store.js';
import { randomUUID } from 'node:crypto';
import { registerRun, attachQuery, unregisterRun, registerPendingQuestion, registerPendingElicitation } from '../runs/active-runs.js';
import { loadSkill } from './skill.js';
import { createHooks } from './hooks.js';
import { createNodesignMcpServer } from '../mcp/index.js';
import { createAgents } from '../agents/index.js';
import { getOrStartProxy } from '../../lib/binary-fixup-proxy.js';

// NoDesign agent 通用 prelude —— append 在 SDK preset 'claude_code' 之后、
// SKILL.md 之前。教 Claude Code 工具用法 + NoDesign 工作台共性约束（assets
// 必看 / 信息不足先问 / git 不自管）。所有 NoDesign agent 共用，跟具体 skill
// 解耦。模块级 readFileSync 一次性读入，避免每次 runAgent 重读。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NODESIGN_PRELUDE = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'prompts/nodesign-prelude.md'),
      'utf8',
    ).trim();
  } catch (err) {
    console.warn(`[loop] failed to load nodesign-prelude.md:`, err.message);
    return '';
  }
})();

// Phase 3.1：plan-mode workflow instructions（替换 SDK 默认 code-impl phases）
// SDK 在 permissionMode='plan' 时把这段嵌入到 plan-mode system reminder 里，
// 自动包 read-only enforcement preamble + ExitPlanMode protocol footer。
// 内容是 NoDesign 设计场景特化版（设计 plan / 隐喻 / per-page 决策等），
// 不是 code implementation。
export const NODESIGN_PLAN_INSTRUCTIONS = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'prompts/nodesign-plan-instructions.md'),
      'utf8',
    ).trim();
  } catch (err) {
    console.warn(`[loop] failed to load nodesign-plan-instructions.md:`, err.message);
    return '';
  }
})();

// SDK base 工具白名单（Options.tools，sdk.d.ts:1216）—— 限定主 agent 可见的
// **内置工具**集合。MCP 工具（mcp__nodesign__*）由 mcpServers 字段独立暴露，
// 不需要列在这里；新加内置工具（如 ExitPlanMode）按需追加。
//
// 设计要点：
//   - Bash 是必需（git/playwright/zip 都靠它）。沙盒由 OS 级 sandbox 字段保证
//   - AskUserQuestion 是 deferred 工具：bypassPermissions 不影响它；canUseTool
//     callback 拦截它注入用户答案（loop.js canUseTool 段）
//   - WebFetch（SDK 内置）走 binary 自带的 prompt 总结，不灌完整 HTML 给 model；
//     WebSearch 走我们自己的 mcp__nodesign__web_search（4 provider，免 server_tool_use）
//   - Task 是子代理调用入口；agents 字段注册的子代理通过 Task 暴露给主 agent。
//     **Task 漏挂 = 所有子代理形同摆设**（P0+ stage 1 修复过一次的隐性 bug）
//
// 非显式语义：
//   - tools 字段是"可见集合"白名单，不在里面的内置工具会被剥离
//   - 不是 auto-allow（auto-allow 由 permissionMode='bypassPermissions' 已经全
//     跳）。之前 sdkOptions 同设 allowedTools 是冗余，已删
export const DEFAULT_TOOL_ALLOWLIST = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash',
  'AskUserQuestion',
  'WebFetch',
  'Task',
  'ExitPlanMode',
];

// 主产物候选 — canvas.html 列首位（P0 per-project workspace 主文件名），
// 其余兼容 deec72d 之前的 e2e smoke / 旧 deskskill-engine 输出。
const ARTIFACT_CANDIDATES = ['canvas.html', 'deck.html', 'index.html', 'output.html'];

// P0+ s1 C24：流式打字效果（text / thinking 逐 token 推送）。
// 跟 sdkOptions.includePartialMessages 同步 —— 我们默认开（前端要打字效果）。
// 启用时 handleAssistantBlocks 跳过 text/thinking blocks（已经从 stream_event 推完，
// 避免双推），但仍推 tool_use（stream_event 里 tool_use input 是 partial JSON delta
// 不好用，等 assistant message 完整 block 来一次更省事）。
export const STREAMING_ENABLED = true;

// canUseTool 已撤（hotfix-sdk-usage）：实测发现 canUseTool always-allow
// 不能阻止 binary 子进程内部走 stdio prompt（permissionMode='default' 默认
// 会 prompt for dangerous operations，spawn 没接 stdin → hang）。
// 改用 permissionMode: 'bypassPermissions' + allowDangerouslySkipPermissions
// 跳过所有 permission 检查；危险命令拦截走 PreToolUse hook（C5 Bash 白名单）。
// stage 2 接 D 流权限交互时改成真处理（前端 UI 弹窗）。

/**
 * 按 model id 选 thinking config（SDK 把 thinking 通道按模型分两路）。
 *
 * sdk.d.ts:1374-1385 + :5342-5368：
 *   - { type: 'adaptive' } 仅 Opus 4.6+ 支持（Claude 自决何时/多少 thinking，是这些模型的 SDK 默认）
 *   - { type: 'enabled', budgetTokens } 是 older-model 路径（Sonnet 4.5 / Sonnet 4 / Haiku 4.5 / 第三方）
 *
 * Kimi K2.6 走 Anthropic 协议但 capability 跟 Sonnet 4.5 同级 —— 视同 older
 * model 走 enabled 路径。adaptive 在非 Opus 4.6+ 上等于不开 thinking
 * （H3 实测：Kimi+adaptive → jsonl 0 thinking blocks），所以默认走 enabled。
 *
 * Future-proof 设计：
 *   - claude-opus-4-[6789] 覆盖 4.6/4.7/4.8/4.9
 *   - claude-opus-[5-9] 覆盖 5.x/6.x/7.x/8.x/9.x（默认假设 Opus 新一代仍走 adaptive）
 *   - 新一代 Opus 改了行为时再扩 regex
 */
export function pickThinkingConfig(model) {
  if (model && /^claude-opus-(?:4-[6789]|[5-9])/.test(model)) {
    return { type: 'adaptive' };
  }
  return { type: 'enabled', budgetTokens: 8192 };
}

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
 * H3：sessionWorkspaceRoot 是新的"agent cwd 起点"——sessions/<sid>/ 目录。
 * shared 资源（assets、CLAUDE.md 等）通过软链 + additionalDirectories 让
 * agent 能读到。
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.skillId
 * @param {string} opts.brief
 * @param {EventBus} [opts.eventBus]
 * @param {AbortController} [opts.abortController]
 * @param {object} [opts.modelOverride]
 * @param {string[]} [opts.toolAllowlist]
 * @param {string} [opts.projectId]              - 用来推断 shared 路径（additionalDirectories）
 * @param {string} [opts.sessionId]              - SDK options.sessionId（新建/fork 时传）
 * @param {string} [opts.sessionWorkspaceRoot]   - sessions/<sid>/ 绝对路径。cwd
 *                                                  用这个；CLAUDE_CONFIG_DIR 落到下面
 * @param {string} [opts.workspaceRoot]          - 老接口（兼容 _smoke / 老 runId 模式）；
 *                                                  H3 turn endpoint 走 sessionWorkspaceRoot 那条
 * @param {string} [opts.resumeSessionId]        - SDK 续 session
 * @param {Array} [opts.userContentBlocks]       - SDK BetaContentBlockParam[]
 * @param {string} [opts.sessionTitle]           - 新建 session 的自定义标题（SDK options.title）
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
  projectId = null,
  sessionId = null,
  sessionWorkspaceRoot = null,
  workspaceRoot = null,
  resumeSessionId = null,
  userContentBlocks = null,
  sessionTitle = null,
  initialPermissionMode = null,  // Phase 3.1：'plan' 启用 SDK 原生 plan-mode；其他保留 bypassPermissions
}) {
  if (!runId) throw new Error('runAgent: runId required');
  if (!skillId) throw new Error('runAgent: skillId required');
  if (!brief) throw new Error('runAgent: brief required');

  // H3：cwd 优先 session 子目录，shared 通过 additionalDirectories
  const cwdRoot = sessionWorkspaceRoot || workspaceRoot;
  const sharedRoot = (projectId && sessionWorkspaceRoot)
    ? path.join(sessionWorkspaceRoot, '..', '..', 'shared')
    : null;

  const ctx = new AgentContext({ runId, skillId, eventBus, abortController, workspaceRoot: cwdRoot });

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
  // 解析最终 model id —— thinking config 的 type 选择依赖它（pickThinkingConfig）。
  const model = modelOverride.model || process.env.NODESIGN_MODEL || 'kimi-k2.6';

  // SDK binary 对非白名单 model（如 kimi-k2.6）会强制把 thinking type 转成
  // 'adaptive'，但 Kimi gateway 不支持 adaptive → 0 thinking blocks。
  // binary-fixup-proxy 在 binary 出口拦 /v1/messages POST 把 adaptive 改回
  // enabled+budget_tokens，让 Kimi 正确输出 thinking。详见
  // memory `feedback_kimi_thinking_blocks.md` + lib/binary-fixup-proxy.js 注释。
  const realGatewayUrl = process.env.NODESIGN_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL;
  let baseUrlForBinary = realGatewayUrl;
  if (realGatewayUrl) {
    try {
      const proxy = await getOrStartProxy(realGatewayUrl);
      baseUrlForBinary = proxy.baseUrl;
    } catch (err) {
      console.warn(`[loop] binary-fixup-proxy start failed, using direct gateway:`, err.message);
      // fail-soft：proxy 起不来回退到直连，thinking 可能仍丢失但 agent 能跑
    }
  }

  const sdkOptions = {
    cwd: cwdRoot,
    abortController: ctx.abortController,
    // H3：新建 session 时显式传 sessionId 让 SDK 用我们预生成的 UUID
    // （d.ts:1537 sessionId 单独可传，不能跟 resume 同用）
    ...(sessionId && !resumeSessionId ? { sessionId } : {}),
    // 新建 session 时传自定义 title（sdk.d.ts:1758）。resume 场景 SDK 用持久化
    // 的 title，传 title 也会被忽略 —— 但避免传歧义值，仅新建场景传。
    ...(sessionTitle && !resumeSessionId ? { title: sessionTitle.slice(0, 80) } : {}),
    // H3：让 agent 能 Read shared/.claude（已通过软链）+ shared/assets/
    // additionalDirectories 是 SDK 暴露给 cwd 之外的可访问目录
    ...(sharedRoot ? { additionalDirectories: [sharedRoot] } : {}),

    // 关键：env 透传给子进程，让 claude binary 走 Nodesign gateway。
    // ANTHROPIC_BASE_URL 不直连真 gateway，而是先经 binary-fixup-proxy
    // （见 baseUrlForBinary 解析）。proxy 起不来时 fallback 到直连。
    env: {
      ...process.env,                                                  // 透传基础 env
      ANTHROPIC_BASE_URL: baseUrlForBinary,
      ANTHROPIC_API_KEY: process.env.NODESIGN_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
      // H3：per-session 隔离 —— SDK binary 子进程把 JSONL 落到 sessions/<sid>/.claude/。
      // session 自包含：删 session = 删 sessions/<sid>/ 子目录（含转录 + canvas + git）。
      // 跨 session 共享配置（CLAUDE.md / agent-memory / assets）通过软链拿到，
      // SDK settingSources: ['project'] 读 cwd/.claude/CLAUDE.md → 软链 → shared。
      // NODESIGN_CONFIG_DIR env 可全局覆盖（生产容器统一持久化卷场景）。
      CLAUDE_CONFIG_DIR: process.env.NODESIGN_CONFIG_DIR || path.join(cwdRoot, '.claude'),
      // ANTHROPIC_SMALL_FAST_MODEL（S9 保守版）：
      // SDK helper（promptSuggestions / agentProgressSummaries / askUserQuestion
      // classifier / title gen / WebFetch summarize 等）默认走 claude-haiku
      // → Kimi gateway 返 400 "模型不存在"，WebFetch 整个错传回 agent。
      //
      // 主 agent 用 kimi-k2.6 时，helper 改用 kimi-k2.5（同一 Moonshot 后端，
      // 但 model 名不同 → proxy 可针对 k2.5 单独关 thinking，不影响 k2.6 主 agent）。
      // proxy fix 在 binary-fixup-proxy.js：parsed.model === 'kimi-k2.5' 时
      // 强制 thinking: disabled，避免 Moonshot "reasoning_content missing" 严格拒。
      ...(model && /^kimi-k2\.6/i.test(model) ? {
        ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k2.5',
      } : {}),
    },

    model,

    // 工具白名单（base 内置工具集合，sdk.d.ts:1216）
    // permissionMode='bypassPermissions' 已经跳所有 prompt → 不需要 allowedTools
    tools: toolAllowlist,

    // hotfix-sdk-usage：systemPrompt 改 preset 'claude_code' + append。
    // 之前用 string 完全替换 SDK 默认 prompt → 失去 Claude Code 的关键
    // 行为约束（何时停 / be concise / task completion 信号 / 工具最佳实践），
    // 导致 agent 一个 turn 做 30+ 件事停不下来。
    // 现在继承 preset + 拼两段 append：
    //   1. NODESIGN_PRELUDE —— Claude Code 工具用法 + NoDesign 工作台共性约束
    //      （所有 NoDesign agent 共用；模块级一次性读 prompts/nodesign-prelude.md）
    //   2. skill.systemPrompt —— 当前 skill 自己的业务约束（视觉风格 / 业务工具
    //      时机 / 收尾格式 / skill 级 don'ts）
    // SDK 拼接顺序: preset → prelude → skill body —— 通用 → 业务，从抽象到具体。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [NODESIGN_PRELUDE, skill.systemPrompt].filter(Boolean).join('\n\n---\n\n'),
    },

    // permissionMode 优先级：
    //   - initialPermissionMode='plan' → SDK 原生 plan mode（read-only + ExitPlanMode）
    //     plan 通过审批后 host 调 query.setPermissionMode('default') 切回，agent 继续 generate
    //   - 其他场景 → bypassPermissions（跳所有 prompt；危险命令由 sandbox 隔离）
    //
    // 'bypassPermissions' 仍是默认：default mode 会 prompt for dangerous
    // operations（binary 子进程通过 stdio prompt → spawn 没接 stdin → hang）；
    // canUseTool always-allow 不能 override 这个。所以默认走 bypass，唯独 plan
    // mode 显式选时切 plan（plan mode 自身是 read-only，不会触发 dangerous prompt）。
    permissionMode: initialPermissionMode === 'plan' ? 'plan' : 'bypassPermissions',
    allowDangerouslySkipPermissions: initialPermissionMode !== 'plan',

    // Phase 3.1：plan mode workflow body（仅在 permissionMode='plan' 时生效）
    // SDK 自动包 read-only preamble + ExitPlanMode footer
    planModeInstructions: NODESIGN_PLAN_INSTRUCTIONS,

    // A4.1：canUseTool 回归 —— 专门处理 AskUserQuestion 这种 deferred + 需要
    // 用户交互的工具。bypassPermissions 跳的是 standard prompt，但 deferred
    // 工具（cli.js GR6 定义 shouldDefer:true + requiresUserInteraction:true）
    // 仍走 canUseTool callback 让 host 程序提供 input.answers。
    //
    // 流程：
    //   1. 模型调 AskUserQuestion → tool checkPermissions 返 'ask'
    //   2. SDK 调我们这个 canUseTool callback
    //   3. 拦到 AskUserQuestion → registerPendingQuestion 拿 Promise →
    //      emit run.ask_user_question 给前端 → await Promise
    //   4. 用户在 AskUserQuestionView 点选项 → POST /answer →
    //      provideAnswer(runId, toolUseId, answers) resolve Promise
    //   5. canUseTool 返 { behavior: 'allow', updatedInput: { ...input, answers } }
    //   6. binary 拿到 updatedInput → 调 tool.call → 工具直接返回 answers
    //      → 模型看到 "User has answered: q1=A, q2=B"
    //
    // 其他工具 always-allow（不阻塞）。canUseTool 出错（如 run cancel）→
    // deny + interrupt 让 SDK 走错误路径。
    //
    // 注意（2026-05-02 EXPERIMENT Round 1）：实验注释掉这段后续 turn 仍然报
    // "reasoning_content is missing"，证实 canUseTool **不是** binary 续 turn
    // 不 merge 的 culprit。已恢复。下次调查方向看 memory feedback_kimi_split_messages_strict.md。
    canUseTool: async (toolName, input, options) => {
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'allow' };
      }
      const toolUseId = options?.toolUseID;
      if (!toolUseId) {
        // 不该发生 —— SDK 总会传 toolUseID。fail-soft：deny 让模型重试或换工具
        return { behavior: 'deny', message: 'AskUserQuestion missing toolUseID', interrupt: false };
      }
      try {
        ctx.emit(Events.askUserQuestion(toolUseId, input?.questions || []));
        const answers = await registerPendingQuestion(runId, toolUseId);
        return {
          behavior: 'allow',
          updatedInput: { ...input, answers },
        };
      } catch (err) {
        // 用户取消 / 超时 / 服务挂了 → deny + interrupt 让 SDK 走 cancelled 路径
        return {
          behavior: 'deny',
          message: `AskUserQuestion: ${err.message}`,
          interrupt: true,
        };
      }
    },

    // Phase 2.3：onElicitation 回调框架（sdk.d.ts:1320）
    // MCP server 想要 elicit 用户输入（form / URL auth）时 SDK 调这个。
    // 当前 13 个 NoDesign MCP 工具都没用 elicit；本框架是 future-proof：未来
    // 任何 NoDesign 或外接 MCP 工具想 elicit 时立即可用。
    //
    // 流程跟 AskUserQuestion 类似：
    //   1. SDK 调 onElicitation(request, options)
    //   2. host 生成 reqId + emit 事件 + await Promise
    //   3. 前端展示 form / URL auth 卡片（待 UI 实现）
    //   4. 用户填完 POST /elicit/:reqId/answer → provideElicitation → resolve
    //   5. SDK 拿到 ElicitationResult 继续
    //
    // 当前没前端 UI，临时策略：emit 事件后默认 decline（不 hang），后续接通 UI
    // 时把 decline 改成真 await。
    onElicitation: async (request, _options) => {
      const reqId = randomUUID();
      try {
        ctx.emit({ type: 'run.elicitation_request', reqId, request });
      } catch { /* ignore */ }
      // TODO: 接通前端 UI 后改成 await registerPendingElicitation(runId, reqId)
      // 当前直接 decline，避免 hang
      try {
        const p = registerPendingElicitation(runId, reqId);
        // 5s 内等不到答案 → 自动 decline（防 MCP 工具卡死整个 agent loop）
        const timeoutPromise = new Promise(resolve =>
          setTimeout(() => resolve({ action: 'decline' }), 5000),
        );
        return await Promise.race([p, timeoutPromise]);
      } catch {
        return { action: 'decline' };
      }
    },

    // toolConfig.askUserQuestion.previewFormat='html' (sdk.d.ts:5381)：
    // 让 SDK 工具 schema 告诉 model option.preview 字段是 self-contained HTML
    // fragment（不是 markdown）—— 配合前端 AskUserQuestionView 的 sandbox iframe
    // 渲染，agent 能给"视觉方向 / 字体方案 / 排版风格"等问题塞真实视觉变体
    // mockup（240x140 小卡片样式）。paradigm "ask 阶段多变体 preview 当问题用"
    // 的接通点。SKILL.md / prelude 会教 agent 怎么写这种 HTML。
    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },

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
    // 按 model id 分两路：Opus 4.6/4.7 → 'adaptive'（这俩模型独家支持，是 SDK
    // 默认）；Sonnet 4.5 / Sonnet 4 / Haiku 4.5 / Kimi K2.6 等其他模型走
    // 'enabled' + budgetTokens 8192（older-model 路径）。Kimi 视同 Sonnet 4.5。
    // 详见 pickThinkingConfig() 注释 + sdk.d.ts:1374-1385。
    // modelOverride.thinking 可显式覆盖（绕过自动选择）。
    thinking: modelOverride.thinking || pickThinkingConfig(model),
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

      // 网络：MVP 阶段全域允许（'*'）让 agent 能 curl 下载外部资源到 ./assets/。
      // 生产可改具体白名单（unsplash / google-fonts / jsdelivr / pixabay 等）。
      // 默认无 allowedDomains 时 SDK sandbox 是 deny-all，连 NODESIGN_GATEWAY_URL
      // 都连不上 —— 必须显式设。
      network: {
        allowLocalBinding: false,
        allowedDomains: ['*'],
      },

      // 文件系统：核心隔离层
      // - allowWrite: session 沙盒（cwdRoot）+ shared/agent-memory（跨 session memory）
      //   + shared/assets（agent 用 curl/Write 下载 / 保存外部资源到 ./assets/，
      //   软链解析后是 sharedRoot/assets）
      // - denyWrite: 系统目录硬封（即便 allowWrite 误配也兜底）
      // - denyRead: /etc/* 系统凭据 + ~/.ssh / ~/.aws 用户凭据
      filesystem: {
        allowWrite: [
          cwdRoot,
          ...(sharedRoot ? [
            path.join(sharedRoot, '.claude', 'agent-memory'),
            path.join(sharedRoot, 'assets'),
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

    // canUseTool 已撤（hotfix-sdk-usage）—— 见 permissionMode: 'bypassPermissions' 注释

    // hooks 4 件套（C3 骨架，C4-C7 逐个填实）：
    // FileChanged / PreToolUse(Bash) / Stop / PostCompact
    hooks: createHooks({ ctx, workspaceRoot: wsRoot }),

    // 自定义 MCP 工具集（in-process）：13 个 nodesign 业务工具
    // 感知层 / 控制层 / 反馈层 / 产物层 / 研究层（详见 mcp/index.js 顶部注释）
    // alwaysLoad: true 在 createNodesignMcpServer 里设了 — 全 schema 注入 system
    // prompt，避免 SDK 默认 defer 行为让 agent 看不见这些工具
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
    // 注：resume 失败 fallback 已删（Phase 4.1 cleanup）。原本是为 streamInput
    // 之前的 per-turn jsonl resume 路径兜底——现在生产 turn endpoint 走 runSession
    // 完全不依赖 jsonl resume；此 runAgent 入口仅留给 _probe-* 测试脚本，它们
    // 都不传 resumeSessionId，永远不会触发那个兜底。
    const stream = query({ prompt: promptInput, options: sdkOptions });

    // query() 返回的就是 Query handle（继承 AsyncGenerator<SDKMessage, void>）。
    // 立即把它 attach 到 active-runs，让上层 endpoint 能调
    // interrupt/setModel/rewindFiles/getContextUsage/mcpServerStatus/...
    // 在 attachQuery 之前的窗口里，cancelRun 会 fallback 到 abortController.abort。
    attachQuery(runId, stream);

    // A2.1：实时上下文用量推送。
    // 每个 assistant message 后 fire-and-forget 一次 query.getContextUsage()
    // → 前端 ContextUsageBar 渲进度条 + breakdown + autoCompact 阈值预警。
    //
    // - **fire-and-forget**：不 await，避免阻塞 message 流；in-flight 守护防堆积
    //   （上一次还没返回 / 慢 control request 时下一次 skip）
    // - **fail-soft**：getContextUsage 可能在 binary init 完成前调到，或者 stream
    //   端到端 race，try/catch 警告但不抛
    // - **粒度**：per-assistant 比 per-turn 灵敏 —— 用户能看到上下文随每个
    //   thinking/tool block 真实涨。control request 走 stdio JSON IPC，开销很小
    let usageInFlight = false;
    let usageOkCount = 0;
    let usageFailCount = 0;
    const emitContextUsage = () => {
      if (usageInFlight) return;
      usageInFlight = true;
      stream.getContextUsage()
        .then((usage) => {
          if (usage) {
            ctx.emit(Events.contextUsage(usage));
            usageOkCount++;
            // 第一次成功打个 info 日志便于诊断（前端没看到 ContextUsageBar 进度条时
            // 用户能看 backend 终端是否有 'getContextUsage ok' 行）
            if (usageOkCount === 1) {
              console.info(`[run ${runId}] getContextUsage ok — totalTokens=${usage.totalTokens} maxTokens=${usage.maxTokens} pct=${usage.percentage?.toFixed(1)}%`);
            }
          } else {
            usageFailCount++;
            if (usageFailCount === 1) {
              console.warn(`[run ${runId}] getContextUsage returned null/undefined — binary 可能不实现 control request`);
            }
          }
        })
        .catch((err) => {
          // 不是错；可能 binary 还没 init 完 / stream 已 end / control request race
          usageFailCount++;
          if (usageFailCount === 1) {
            console.warn(`[run ${runId}] getContextUsage failed (1st time, will keep trying silently):`, err.message);
          }
        })
        .finally(() => {
          usageInFlight = false;
        });
    };

    for await (const message of stream) {
      ctx.ensureNotAborted();
      handleSDKMessage(ctx, message);

      // A2.1：assistant message 后推一次 context usage（不阻塞）
      if (message.type === 'assistant') emitContextUsage();

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
export function handleSDKMessage(ctx, msg) {
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
  if (!evt) return;

  // tool_use 起点 —— content_block_start { content_block: { type: 'tool_use', id, name } }
  // 推 toolUseStarted 让前端立即显示 icon + tool name（status='running'）。
  // input 还没流完，等 assistant message 完成后 deltaToolUse 同 blockId update。
  // 体感：agent "想完→开干" 之间几乎没延迟，工具图标第一时间出现。
  if (evt.type === 'content_block_start') {
    const cb = evt.content_block;
    if (cb && cb.type === 'tool_use' && cb.id && cb.name) {
      ctx.emit(Events.toolUseStarted(ctx.counters.turns, cb.id, cb.name));
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

export async function detectArtifact(ctx) {
  for (const candidate of ARTIFACT_CANDIDATES) {
    if (await ctx.workspace.exists(candidate)) return candidate;
  }
  return null;
}
