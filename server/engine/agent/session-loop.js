/**
 * server/engine/agent/session-loop.js — Long-running query session loop
 *
 * SDK streamInput 模式：一个 SDK Query 持续吃 user message 跨多 turn，conversation
 * state 留在 SDK binary 内存里，**不依赖 jsonl resume**。这是 NoDesign 主代理唯一
 * 入口（曾有 per-turn 的 loop.js runAgent，2026-05-03 后已彻底移除）。
 *
 * 解决 per-turn query 架构的两个痛点：
 *   1. cancel 时 jsonl 残缺 → 下个 turn resume 失败丢上下文（streamInput 不 resume）
 *   2. 用户在 agent 跑时无法追加消息（streamInput 排队天然支持）
 *
 * 设计要点：
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
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { AgentContext, freshTurnCounters } from './context.js';
import { Events } from './events.js';
import { createRun, markRunStarted, markRunSucceeded, markRunFailed, mergeRunMetadata, setRunMetrics, setRunModelUsage } from '../runs/store.js';
import { getProject } from '../../projects/store.js';
import { modeSkillsFor } from '../mcp/mode-profile.js';
import { randomUUID } from 'node:crypto';
import {
  registerQuerySession,
  attachSessionQuery,
  unregisterQuerySession,
  getCurrentTurnRunId,
  setCurrentTurnRunId,
  registerPendingQuestion,
  registerPendingElicitation,
  getSessionPermissionMode,
  getSessionLastActivity,
  closeQuerySession,
  markSessionActivity,
} from '../runs/active-runs.js';
import {
  promoteNextPendingRunId, claimRunByUuid, releaseCurrentTurnRunId, getPendingRunCount,
  isBackgroundTurnOpener,
  closeMergedRun, publishQueueDepth, pushUnclaimedMessage,
} from '../runs/turn-relay.js';
// skill 起手文件拷贝已挪 hooks.js PreToolUse(Skill/Bash)（2026-07-27），
// session-loop 不再直接依赖 skill.js；skillId 参数仅作兼容保留。
import { loadInstalledPlugins } from './plugin-loader.js';
import { createHooks } from './hooks.js';
import { buildIsolationOptions, prepareAgentDirs, sandboxShimEnv } from './isolation.js';
import { MEMORY_EXTRA_GUIDELINES, mergeAgentSettings } from './memory-config.js';
import { createNodesignMcpServer } from '../mcp/index.js';
import { MCP_SERVER_NAME } from '../mcp/server-name.js';
import { assertInitContract } from './init-contract.js';
import { clearSessionFlights } from './subagent-flight.js'; import { clearStageStatus } from './stage-status.js';
import { createRoleRoster } from './cast.js';
import { createAgents } from '../agents/index.js';
import { resolveSdkSpoofModel, pickThinkingConfig, isUncensoredModel } from './model-context.js';
import { bindSessionUpstream, unbindSessionFromRelay } from './session-binding.js';
import { resolveSessionModel } from './session-model.js';
import { unregisterIngressSession } from '../../lib/model-ingress.js';
import { takeUpstreamBilling } from '../../lib/ingress/upstream-billing.js';
import { takeUpstreamTruncation } from '../../lib/ingress/upstream-truncation.js';
import { unregisterSessionNotice } from '../../lib/ingress/session-notice.js';
import { clampFirstClause } from '../../lib/quick-summary.js';
import { AsyncQueue } from '../../lib/async-queue.js';
import { platform } from '../../runtime/platform.js';
import { renderPrelude } from './system-prompts.js';
import {
  DEFAULT_TOOL_ALLOWLIST,
  STREAMING_ENABLED,
  handleSDKMessage,
  detectArtifact,
} from './agent-shared.js';
import { autoNameProjectFromSession } from '../../projects/auto-name.js';
// 合流并集（2026-08-13）：commitWorkspace/taskManifest 是扁平化这边的，
// getUserById/levelFor 是 main 的每用户内容尺度旋钮（78ceaac）；
// main 的 listTasks 已随任务层退役，不再引入
import { commitTaskWorkspace, commitWorkspace, PROJECTS_DATA_ROOT } from '../../projects/workspace.js';
import { commitStaging } from '../../projects/board-tags.js';
import { taskManifest } from '../../lib/artifact-target.js';
import { getUserById } from '../../auth/users-store.js';
import { defaultModerationLevel } from '../../auth/tier.js';

/**
 * 半截续接时替 agent 说的那句话（见 maybeContinueTruncated）。写成"系统提示"而不是装成用户说话：
 * 模型看得见前面那段半截是自己说的，让它接着写，别从头重来（重来一遍用户要看两份）。
 */
const CONTINUATION_PROMPT = '[系统] 上一条回复在传输途中被上游中断了，没有说完。请从被截断的地方接着写完，不要重复已经说过的内容，也不要为此道歉。如果上一条其实已经把话说完了，就继续执行手头的任务。';
import { levelFor } from '../../lib/moderation.js';

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
 * @param {string[]} [opts.toolAllowlist=DEFAULT_TOOL_ALLOWLIST]
 * @param {string} [opts.initialPermissionMode]
 * @param {string} [opts.initialRunId] - 首条 turn 的 run record id；若给则 register
 *                                       完立即设 currentRunId，避免 turn.js race
 *                                       condition（push 早于 register 没法关联 runId）
 * @returns {Promise<void>}  - inputQueue 关闭时 resolve
 */
/**
 * SDK 自发 turn 的开启信号：真实的模型/对话活动（assistant 输出、流式增量、
 * SDK 注入的 user 消息）。task_notification / task_progress / notification 等
 * 旁路事件**不算** —— 通知之后 SDK 不一定真的唤起模型，铸了 run 却等不来
 * result 收尾就是僵尸 run。
 */

export async function runSession({
  sessionId,
  projectId,
  ownerId = null,   // 项目 owner；订阅通路在 OAuth 决策那一行按 auth/tier.js 断言资格（见下）
  sessionWorkspaceRoot,
  eventBus,
  inputQueue,
  skillId = 'deskskill-engine-mini',
  sessionTitle = null,
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

  // 2026-08-07 扁平化：cwd 就是项目工作区，`sharedRoot` 和它是同一个目录。
  // 旧代码在这里用 `../../shared` 从会话沙盒爬回共享目录 —— 那条相对路径现在
  // 会爬到数据根之外，两个名字保留只是为了不动下游几十处引用。
  const cwdRoot = sessionWorkspaceRoot;
  const sharedRoot = cwdRoot;
  const sessionMetaRoot = path.join(cwdRoot, '.nd', sessionId);

  const sessionAbortController = new AbortController();
  // initialPermissionMode 落进 active-runs，canUseTool 通过 getSessionPermissionMode 读
  // 当前 mode（auto 模式升级口按它分流）。turn.js 入口的 mode 校正会同步更新本字段。
  // （plan mode 08-21 整体移除；这里不再有 'plan' 分支）
  const initialModeNormalized = 'bypassPermissions';
  // sessionToken：身份证。closeQuerySession 已同步让出 sid 后用户立即重发起新
  // runSession → 新 register 拿到新 token；旧 runSession finally 调 unregister 带
  // 旧 token 比对不匹配 → noop 不误删新 entry。
  const sessionToken = registerQuerySession(sessionId, {
    abortController: sessionAbortController,
    inputQueue,
    initialPermissionMode: initialModeNormalized,
  });
  // 关键 race guard：registerQuerySession 拒绝重复注册（同 sid 已活跃）→ 这次
  // runSession 是冗余调用（前端 race / 后端 fallback / resume race），直接 early
  // return 不 spawn 第二个 SDK binary。否则两个 binary 并行 Write 同 canvas.html
  // 就是用户报告的"独立 main 进程在 write"。
  if (!sessionToken) {
    console.warn(
      `[session-loop] runSession sid=${sessionId.slice(0, 8)} skipped — already active. `
      + `Caller (turn.js) should have used pushUserMessage instead of startNewRunSession.`
    );
    // 这条消息 push 进了一个无人消费的新 inputQueue —— 不能静默丢。标 run 失败 +
    // emit run.error 让前端弹提示，用户重发即走 pushUserMessage 正常路径。
    if (initialRunId) {
      try { markRunFailed(initialRunId, 'duplicate session registration race'); } catch { /* */ }
    }
    try {
      eventBus.publish({
        type: 'run.error',
        sessionId,
        ...(initialRunId ? { runId: initialRunId } : {}),
        message: '会话正忙，这条消息没有进入队列，请重发一次',
        code: 'DUPLICATE_SESSION',
        ts: new Date().toISOString(),
      });
    } catch { /* */ }
    return;
  }
  // initialRunId：register 后立刻设 currentRunId，让 for-await-of 第一次见到
  // SDK 转发首条 user message 时直接知道当前 turn 的 runId（否则 turn.js 那边
  // 必须在 register 之后才能调 pushUserMessage —— race window）
  if (initialRunId) setCurrentTurnRunId(sessionId, initialRunId);

  // session-level start event（Phase 2，前端识别 query alive）
  eventBus.publish({ type: 'run.query.start', sessionId, ts: new Date().toISOString() });

  // sharedCtx：跨 turn 复用。每个 turn 边界覆盖 runId + 重置 counters。
  // hooks / mcp 闭包持稳定引用即可。
  // sessionId 传入让 ctx.emit 自动 enrich event.sessionId，WS handler 按 sid 过滤
  // 防多 session / 多 tab 跨 session 串扰（project bus 共享）。
  // model 优先级：调用方显式 > session-config.json（用户在 picker 选的，随会话
  // 持久）> env 全局默认。这条链现在只写在 session-model.js 一处 —— 以前它在这里、
  // turn.js、canvas.js 各有一份写法不同的复制品，对不上的时候没人发现。
  const { model: resolvedModel } = await resolveSessionModel(sessionMetaRoot);
  const model = resolvedModel;
  const sdkModel = resolveSdkSpoofModel(model);

  // appModel env：session-level，由 try 块内 + finally 配对管理。详见 line 558 注释。

  const sharedCtx = new AgentContext({
    runId: '__session_pending__',
    skillId,
    eventBus,
    abortController: sessionAbortController,
    workspaceRoot: cwdRoot,
    sessionId,
    appModel: model,
  });

  // ── init 段（2026-07-27 起整体 try/catch）——
  // 老代码这些 await 在主 try 块之外，任一抛错 → Promise reject 只被 turn.js
  // console.error，没有 run.start 也没有 run.error，run 行永远 pending，
  // 前端完全零反馈（丢状态路径 P5）。现在失败时补 run.error + markRunFailed。
  let wsRoot, baseUrlForBinary, apiKeyForBinary, fastModel, compactWindow, isResume, installed;
  let noticeHandler = null;   // ingress → 会话的通知回调（注销时按身份比对，别误删新会话的）
  let relaySid = null;        // 在站主 relay 上登记过的 sid（finally 配对注销）
  try {
    wsRoot = await sharedCtx.workspace.ensure();

    // 起手文件拷贝（canvas.template.html 等）2026-07-27 起不再在 init 无条件做 ——
    // 挪到 hooks.js 的 PreToolUse(Skill/Bash)：agent 真的开始 deck 工作
    // （加载 deskskill / cp 模板）才拷。非 deck 会话（便签 / 整理画布）cwd 干净。

    // ── 通路由模型表决定：订阅直连 / 进程内 ingress / 站主 relay，全在 session-binding.js ──
    ({ baseUrl: baseUrlForBinary, apiKey: apiKeyForBinary, fastModel, compactWindow, noticeHandler, relaySid } =
      await bindSessionUpstream({ sessionId, model, ownerId, emit: (ev) => sharedCtx.emit(ev) }));

    // 检测 jsonl 是否已存在 —— 决定走 resume（已存在）还是 sessionId（新建）
    // 之前的 bug：session-loop 永远传 sessionId，但如果用户 close session 后又
    // 用同 sid 起 query（hasActiveQuerySession=false 走 startNewRunSession），
    // SDK binary 看 jsonl 已存在抛 "Session ID ... is already in use"，
    // 子进程死，nodejs 端 stdin write EPIPE 整个 server 挂。
    isResume = await jsonlExistsForSession(cwdRoot, sessionId);

    // 扫已装 plugin（内置 + 用户级 + project 级），返 SDK options 直接用的形态。
    // 装新 plugin 只有重启 session 才生效（v1 接受，详见 plan § "Hot-reload v2"）。
    // skillId 参数（传入的 'deskskill-engine-mini'）保留兼容，但实际 skills 列表以
    // installed.skills 为准 —— 包含所有已装 plugin 内的 skill name 合集。
    // 用户级 plugin 按**项目 owner** 取，不是按"当前请求者"—— 同一个项目谁来跑
    // （owner 自己、后台自发回合、admin 代看）都该是同一套 skill，不然会话行为
    // 会随观看者变。owner 为空（历史项目没回填全）→ 只跳过用户级，别退回共享根。
    installed = await loadInstalledPlugins({
      projectId,
      userId: projectId ? getProject(projectId)?.ownerId : null,
    });
    console.log(
      `[session-loop] plugins=[${installed.plugins.map(p => p.path.split('/').pop()).join(', ')}] `
      + `skills=[${installed.skills.join(', ')}] `
      + `(builtin=${installed.diagnostics.builtin} user=${installed.diagnostics.user} project=${installed.diagnostics.project})`
    );
  } catch (err) {
    console.error(`[session-loop] init failed sid=${sessionId.slice(0, 8)}:`, err.message);
    if (initialRunId) {
      sharedCtx.runId = initialRunId;   // emit 带正确 runId，前端才不会 stale-guard 吞掉
      try { markRunFailed(initialRunId, `init: ${err.message || 'unknown'}`); } catch { /* */ }
    }
    sharedCtx.emit(Events.error(`会话初始化失败：${err.message}`, 'INIT_FAILED', err.stack));
    // registerIngressSession（session-binding.js 里）在本 try 内、其后还有可抛的 await —— 这里配对注销，
    // 否则 init 失败的 API 会话在 ingress 的 sessionRoutes 里残留（2026-08-19 评审抓的洞）。
    // 主路径的注销在下方大 try 的 finally；两处都是幂等 delete，不怕重复。
    unregisterIngressSession(sessionId);
    if (relaySid) { unbindSessionFromRelay(relaySid); relaySid = null; }   // 登记成功后在别的 await 上倒下的，也要注销
    unregisterSessionNotice(sessionId, noticeHandler);
    takeUpstreamTruncation(sessionId);   // 别留标记给下一个同 sid 的会话
    unregisterQuerySession(sessionId, sessionToken);
    try {
      eventBus.publish({ type: 'run.query.end', sessionId, reason: 'init_failed', ts: new Date().toISOString() });
    } catch { /* */ }
    throw err;
  }

  // MCP server 实例落变量：开局契约自检要从**传给 query 的同一个实例**上取预期
  // 工具名（server.toolNames，见 mcp/index.js）——不另立第二份清单。
  // 常驻角色名册：一会话一份，hooks 与 MCP 工具共用同一引用（见 cast.js createRoleRoster）
  const roleRoster = createRoleRoster();
  // 项目模式（08-27）：启动时读一次（切换下个会话生效），同一读数喂工具面（mode-profile.js）和提示词面（nd:mode 分区），两面不岔开
  const projectMode = (projectId ? getProject(projectId)?.mode : null) || 'design';
  const nodesignServer = createNodesignMcpServer({ workspaceRoot: wsRoot, sharedRoot, projectId, sessionId, ctx: sharedCtx, roleRoster, projectMode });
  // npm 缓存 + 沙盒可写 tmp（$TMPDIR / pip 缓存）：细节与教训见 isolation.js
  const agentDirs = await prepareAgentDirs({ dataRoot: PROJECTS_DATA_ROOT, projectId, sessionId });

  // ⛔ 服务器自己的运行姿态不许漏进 agent 环境（08-24 案）：
  //   - NODE_ENV=production（pm2 注的）会让 agent 沙盒里的 npm install 静默跳过
  //     devDependencies —— 返回 0 还报 "up to date"，vite/typescript 根本没装上，
  //     构建道当场断。npm_config_production / npm_config_omit 是同一开关的旁路。
  //   - PWD 是 pm2 进程的 cwd（仓库根）；spawn({cwd}) 不更新它，bash 会自校正但
  //     python/node/构建工具读 $PWD 拿到的就是错目录 ——"cwd 被重置到父目录"的
  //     另一半病根。下面显式钉成 cwdRoot。
  const {
    NODE_ENV: _dropNodeEnv, npm_config_production: _dropNpmProd,
    npm_config_omit: _dropNpmOmit, OLDPWD: _dropOldpwd,
    ...inheritedEnv
  } = process.env;
  const sdkEnv = {
    ...inheritedEnv,
    PWD: cwdRoot,
    ANTHROPIC_BASE_URL: baseUrlForBinary,
    // 订阅模型：apiKeyForBinary = process.env 原值（通常 undefined）——binary 见到
    // ANTHROPIC_API_KEY 会弃用 ~/.claude 订阅 OAuth，所以订阅路绝不能注入。
    // API 模型：占位符（真钥匙在 model-ingress 按上游注入，不经 binary）。
    ANTHROPIC_API_KEY: apiKeyForBinary,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign/0.0.1',
    CLAUDE_CONFIG_DIR: platform.claudeConfigDir,
    // auto-memory 强制开启分支（binary gate：DISABLE 置 falsy 值 = force on，
    // 绕过 CLAUDE_CODE_SIMPLE 等后置门；前置门 U$/zl 若拦住则此招无效 → 走自建 B 计划）
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    // 记忆指导追加段（保留 SDK 原合同只追加产品口径，理由见 memory-config.js）
    CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES: MEMORY_EXTRA_GUIDELINES,
    // 工具搜索：非 alwaysLoad 的 MCP 工具延迟加载（省 ~25-30k 常驻 schema tokens），
    // agent 用 ToolSearch 按需取。白名单见 mcp/index.js ALWAYS_LOAD_TOOLS
    ENABLE_TOOL_SEARCH: 'true',
    // npm_config_cache / CLAUDE_CODE_TMPDIR / PIP_CACHE_DIR（见 isolation.js）
    ...agentDirs.envPatch,
    // auto 模式分类器用哪个模型。判"这个动作越不越界"是需要判断力的活，
    // 默认 opus —— 这一步省钱等于把闸门交给一个更笨的看门人。
    ...(platform.autoModeEnabled ? { CLAUDE_CODE_AUTO_MODE_MODEL: platform.autoModeModel } : {}),
    // bwrap 垫片：绕开 apply-seccomp 的 unshare 竞态（见 isolation.js / ops/sandbox-shim）
    ...sandboxShimEnv({ dataRoot: PROJECTS_DATA_ROOT }),
    // 快速 helper model（SDK 内部 helper：task title 总结、auto-compaction 等）。
    // 通路见上方 route 注释：订阅 = env 可覆盖；API = 表内 fastModel。
    ...(fastModel ? { ANTHROPIC_SMALL_FAST_MODEL: fastModel } : {}),
    // 真实上下文窗口（仅 API 路；订阅路留空让 SDK 用它自己的正确默认）
    ...(compactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactWindow) } : {}),
  };

  const sdkOptions = {
    cwd: cwdRoot,
    strictMcpConfig: true,   // 只认下面 mcpServers 那份（09-06）：不然宿主机 ~/.claude.json 里站主的 claude.ai 连接器会挂进每个用户的会话
    abortController: sessionAbortController,
    // --replay-user-messages（2026-08-20）：让 CLI 把每条用户消息在**真正并进对话
    // 的那一刻**原样回显（带我们 push 时盖的 uuid）。这是 run 记账的 turn 边界锚 ——
    // 没有它就只能靠"一条消息一个 result"计数接力，而 CLI 会把 turn 进行中追加的
    // 消息并进当前轮，链一错就永不自愈。机制全文见 active-runs.js claimRunByUuid。
    // SDK 没把这面旗做成具名选项，走 extraArgs 透传（值 null = 无参布尔旗）。
    extraArgs: { 'replay-user-messages': null },
    // 新建 → sessionId 让 SDK 用我们的 sid；已存在 → resume 续 jsonl 历史
    ...(isResume ? { resume: sessionId } : { sessionId }),
    // title 仅在新建时有效（resume 用持久化的 title）
    ...(sessionTitle && !isResume ? { title: sessionTitle.slice(0, 80) } : {}),
    // additionalDirectories：cwd 外但允许 Read 的目录。
    //   - sharedRoot：project 共享资源（assets / agent-memory / .claude/）
    //   - 每个已装 plugin 根：让 agent 能 Read patterns / references 等 SKILL.md 附件
    //     （SDK Skill 工具只加载 SKILL.md body 自身，附件靠 agent 主动 Read，
    //      要求路径在 sandbox 范围内 — 详见 memory nodesign_sdk_plugin_routes.md）
    additionalDirectories: [
      ...(sharedRoot ? [sharedRoot] : []),
      ...installed.plugins.map(p => p.path),
    ],
    env: sdkEnv,

    // sdkModel = appModel spoofing alias（kimi-k2.6 → claude-opus-4-7[1m]）。
    // 让 SDK 内部 rawMaxTokens=1M，autoCompactWindow=230400 不再被卡 200k；
    // proxy 出口把 alias 还原成真 appModel 给 gateway。详见 model-context.js。
    model: sdkModel,
    tools: toolAllowlist,
    // systemPrompt.append 只放 NODESIGN_PRELUDE（平台协议 / 路径地图 / 工作流硬规则） ——
    // 语义层"平台强制、用户不可覆盖"。SKILL.md（设计方法论） 走 SDK 原生 plugins+skills：
    //   - plugins：加载 server/engine/plugins/nodesign（含 .claude-plugin/plugin.json + skills/）
    //   - skills：把 deskskill-engine-mini 加进 main session 的 skill catalog
    //
    // SDK 行为（sdk.d.ts:1649-1671 / 2598）：SDK 在 system prompt 里给 agent 看到 skill listing
    // （含 frontmatter description，单条截到 1536 字符），agent 自主决定何时通过内置 `Skill`
    // 工具加载 body 进 context。**SDK 自己注入 listing，host 不该再在 prelude 里写硬规则强制
    // invoke** —— description 写好让 agent 主动判断即可。
    //
    // 历史：2026-05-18 之前是 `append: [PRELUDE, skill.systemPrompt].join('\n\n---\n\n')` ——
    // SKILL.md body 全文每 turn 恒驻在 system prompt 里。改造后 system prompt 静态前缀更稳
    // （省 cache），SKILL.md body 只在 agent 真需要决策时进入 context。详见
    // memory/nodesign_system_prompt_architecture.md。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      // 成人段随项目 owner 的外审档联动（renderPrelude）；无主项目落 tier.js 的 strict，绝不落 off。
      // ⚠️ 08-30 默认档按通路拆成两栏（订阅 strict / 非订阅 off）→ 同一个项目换个模型跑成人段就换一档。
      //
      // uncensored 走模型表的标记位（model-context.isUncensoredModel），不在这里
      // 判模型名 —— 那是模型属性，写在这儿就是给那张表开第二个真相源。为 true 的
      // 行拿到的是精简版底线：本地无审查权重跑在自己盒子上、gate 'localGen' 只对
      // 获批账号开、产物不外发，完整那节的前提（对外开放平台）根本不成立。
      append: (() => {
        const owner = projectId ? getUserById(getProject(projectId)?.ownerId) : null;
        // 档位按模型通路取旋钮（08-20 两旋钮：订阅 / 本地与中转），model 是上面已解析的会话模型
        // 无主项目 fail-closed 到 tier.js 的默认（strict），别落 loose（生产 08-21 实查 0 个无主项目）
        // locale：项目 owner 在账号上记的界面语言。null（没表过态）时 renderPrelude
        // 落中文默认 —— 服务端拿不到浏览器语言，这里不猜，猜错比给中文更糟。
        return renderPrelude(owner ? levelFor(owner, model) : defaultModerationLevel(null), {
          uncensored: isUncensoredModel(model),
          locale: owner?.locale || undefined,
          // 项目模式分区（nd:mode 标记块）—— 跟工具面用的是同一次读数，两面不会岔开
          mode: projectMode,
        });
      })(),
    },
    plugins: installed.plugins,
    skills: modeSkillsFor(installed.skills, projectMode),   // 按模式筛+对账（拆件见 mode-profile）

    // 2026-05-18 安全：关 inline shell execution。SDK 默认允许 skill / slash command 内
    // inline shell 命令（Anthropic 标准 skill 协议的一部分，如 setup script）—— 但 NoDesign
    // 允许用户上传 plugin，若不关 = 用户上传的 SKILL.md 含 shell 命令会被 SDK 真的执行 = RCE。
    // 内置 deskskill-engine-mini 不依赖 inline shell，关掉无功能损失。
    // 详见 memory nodesign_sdk_skills_options_internals.md「安全相关 SDK option」。
    disableSkillShellExecution: true,

    // resume 时不传 permissionMode：SDK 会从 JSONL 读原 session flags + 检查
    // bypassPermissions 必须有 --dangerously-skip-permissions 启动才允许。如果
    // 老 session 是在没这个 flag 的版本下创建的（老 SDK / 老代码），现在硬传
    // permissionMode: 'bypassPermissions' 会让 SDK 抛：
    //   "Cannot set permission mode to bypassPermissions because the session
    //    was not launched with --dangerously-skip-permissions"
    // 这个错没有 runId 会被前端 stale guard 吞掉 → 用户看到"完全没反应"。
    // 修：resume 不传 permissionMode 让 SDK 用 JSONL 保存的；运行时切 mode 通过
    // query.setPermissionMode + turn.js POST /turn 入口的 mode 校正路径完成。
    // 默认模式来自 platform（exp 是 'auto' = 模型分类器判每次调用，生产仍是 'bypassPermissions'）。
    ...(isResume ? {} : { permissionMode: platform.permissionModeDefault }),
    // 永远 true：与 permissionMode 正交——只是"允许运行时切 bypassPermissions"的安全
    // 开关，启动当下的 mode 由 permissionMode 字段定。运行时切 mode（turn.js 入口校正）
    // 必须有它，否则 query.setPermissionMode('bypassPermissions') 会被 SDK 拒：
    // "session was not launched with --dangerously-skip-permissions"。
    allowDangerouslySkipPermissions: true,

    // 通用 permission gate
    //
    // ⚠️ SDK 0.2.x permission decision schema 要求 'allow' branch 必带 updatedInput
    // （Zod union 严格验证）；返 `{ behavior: 'allow' }` 缺 updatedInput 会触发
    // ZodError 让工具被拒。'allow' 都要带 updatedInput（不改的话原样透传 input）。
    //
    canUseTool: async (toolName, input, options) => {
      const currentMode = getSessionPermissionMode(sessionId);

      // auto 模式的升级口：分类器自己拿不准的调用会落到这里（它自己判定要拦的
      // 不会来，直接就拒了）。第一版**只记账不拦**——先看真实用量里都有谁会
      // 升上来，再决定拦不拦；这期间分类器的硬拒照样生效。
      // NODESIGN_AUTO_MODE_ESCALATION=deny 改成拦。
      if (platform.autoModeEnabled && currentMode === 'auto') {
        const 因 = options?.decisionReason || options?.title || '(没给原因)';
        console.log(
          `[auto-mode] 升级 sid=${sessionId.slice(0, 8)} tool=${toolName} `
          + `理由=${String(因).replace(/\s+/g, ' ').slice(0, 200)}`,
        );
        if (platform.autoModeEscalation === 'deny' && toolName !== 'AskUserQuestion') {
          return {
            behavior: 'deny',
            message:
              `这个动作没通过平台的自动审批：${String(因).slice(0, 300)}\n`
              + '换个不需要越界的做法；确实必须这么做的话，先跟用户说清楚你要做什么、为什么，让他决定。',
            interrupt: false,
          };
        }
      }

      if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
      const toolUseId = options?.toolUseID;
      if (!toolUseId) {
        return { behavior: 'deny', message: 'AskUserQuestion missing toolUseID', interrupt: false };
      }
      let currentRunId = getCurrentTurnRunId(sessionId);
      if (!currentRunId) {
        // 后台自发 turn（task-notification 唤起）里 agent 问用户 —— 以前直接
        // deny "no active turn"，把带 preview 的候选卡逼退成纯文字。现在铸造
        // 一个真 turn 再放行（mintBackgroundTurn 会 emit run.start 让前端拿到
        // runId，answer 回路照常走）。
        currentRunId = mintBackgroundTurn('AskUserQuestion');
      }
      sharedCtx.emit({ type: 'run.ask_user_question', toolUseId, input });
      try {
        const answers = await registerPendingQuestion(currentRunId, toolUseId);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (err) {
        return { behavior: 'deny', message: err.message, interrupt: true };
      }
    },

    // Phase B 批次 4：MCP elicitation 接通前端 Modal。
    // 流程：MCP 工具调 server.elicitInput() → SDK 调这个回调 → 我们 emit
    // run.elicitation_request 给前端 → ElicitationModal 弹出 → 用户填完 POST
    // /elicit/:reqId/answer → provideElicitation 返回 { action, content } → SDK
    // 拿到结果继续工具调用。
    // 60s 超时是为了给用户填表时间（之前 5s 太短，未来真用 elicit 时永远没机会答）；
    // 仍兜底防 MCP 工具卡死整个 agent loop。
    onElicitation: async (request, _options) => {
      const reqId = randomUUID();
      const currentRunId = getCurrentTurnRunId(sessionId);
      try {
        sharedCtx.emit({ type: 'run.elicitation_request', reqId, request, runId: currentRunId });
      } catch { /* ignore */ }
      if (!currentRunId) {
        return { action: 'decline' };
      }
      try {
        const p = registerPendingElicitation(currentRunId, reqId);
        const timeoutPromise = new Promise(resolve =>
          setTimeout(() => resolve({ action: 'decline' }), 60_000),
        );
        return await Promise.race([p, timeoutPromise]);
      } catch {
        return { action: 'decline' };
      }
    },

    persistSession: true,
    settingSources: ['project'],


    includePartialMessages: STREAMING_ENABLED,
    // 子代理时间轴（2026-07-28）：转发子代理完整对话（text/thinking 也带
    // parent_tool_use_id），前端按它拆「对话」主线和每个子代理的独立时间轴。
    // 默认只透传 tool_use/tool_result（心跳级），不够渲染嵌套 transcript。
    forwardSubagentText: true,

    thinking: pickThinkingConfig(model),
    effort: 'medium',
    // streamInput 模式 query 横跨整个 session，maxTurns 是**全局累计**（每条
    // user message 起一轮 agent loop，turn 数不重置）。15 太低 —— 用户聊几
    // 轮就触顶导致 'error_max_turns' 误中断。改 50 给复杂 deck（多页 +
    // 多次自检 + 子代理）足够余量；env override 给极端情况用
    maxTurns: Number(process.env.NODESIGN_MAX_TURNS)
      || 50,

    // 不传 resume —— streamInput 模式 SDK 内存保 history，不依赖 jsonl
    enableFileCheckpointing: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    forwardSubagentText: true,

    // maxBudgetUsd（2026-07-30 默认撤销）：它只是给 agent 注"USD budget:
    // $X/$N; remaining"的软提醒，SDK 不硬截断；数字还是按 SDK 硬编码价目表
    // × spoofing 模型名算的虚价。订阅 OAuth 模式下实际不按 token 扣费，这个
    // 虚价 reminder 只会给 agent 制造错误紧迫感（少派子代理 / 仓促收尾）——
    // 不传，让 reminder 彻底消失。按量付费网关想要预算线时用
    // NODESIGN_MAX_BUDGET_USD 显式开。
    // （历史：Kimi 时代因 Opus 虚价 30× 把默认从 $10 拉到 $150，现连默认也不要了）
    ...(() => {
      const v = Number(process.env.NODESIGN_MAX_BUDGET_USD);
      return Number.isFinite(v) && v > 0 ? { maxBudgetUsd: v } : {};
    })(),

    // 隔离两道闸（sandbox 管 Bash，permissions.deny 管 Read/Write 这类进程内工具）
    // 全在 agent/isolation.js 里，改之前读那份文件头上的四条实测教训。
    // ⛔ settings 必须与 isolationOptions.settings 深合并 —— 08-15 起两处 settings
    // 静默互吞八天（autoMemory*/skipWebFetchPreflight 全丢）。合并+出口断言在
    // memory-config.js 的 mergeAgentSettings。
    ...(() => {
      const isolation = buildIsolationOptions({ cwdRoot, sharedRoot, ...agentDirs, dataRoot: PROJECTS_DATA_ROOT, env: sdkEnv });
      return {
        ...isolation,
        settings: mergeAgentSettings(isolation.settings, {
          skipWebFetchPreflight: platform.skipWebFetchPreflight, sharedRoot,
          crossSessionInbound: 'refuse',   // 理由见 memory-config.js 那个键的注释
        }),
      };
    })(),

    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },

    // projectId 要传：PostToolUseFailure 记问题库时用它标归属（漏传的话
    // issues 行的 project_id 全是 null，事后追不回是哪个项目踩的）
    hooks: createHooks({ ctx: sharedCtx, workspaceRoot: wsRoot, sharedRoot, sessionId, projectId, roleRoster }),

    mcpServers: {
      // 键名 = 模型眼里的 `mcp__<名>__<工具>` 前缀，也是 isolation.js 那条
      // permissions.allow 规则要匹配的名字 —— 两个读者，收在 mcp/server-name.js
      [MCP_SERVER_NAME]: nodesignServer,
    },

    // mainModel = appModel ('kimi-k2.6')，sdkModel = SDK 视角 alias ('claude-opus-4-7[1m]')。
    // vision-checker 用 sdkModel 让 SDK 信 1M context（绕开"喂真 kimi → SDK 不认 →
    // rawMaxTokens fallback 200k"）；其余子代理走 fastModel，跟以前一致。
    agents: createAgents({ mainModel: model, sdkModel, fastModel }),

    stderr: (data) => {
      console.error(`[session ${sessionId.slice(0, 8)}/claude.stderr]`, data.trim());
    },
  };

  // ── per-turn lifecycle helpers ──

  let activeTurnRunId = null;
  let turnStartedAt = 0;        // 本回合开始时刻（半截标记的新鲜度判据）
  // 半截续接前存下的"第一轮的账"（结账时加回去）。⚠️ 必须声明在 finishTurn **之前**：
  // finishTurn 引用它，写在下面的 try 块里会让闭包够不着 → 每个回合都 ReferenceError
  // （真路径探针逮到的，node --check 和单测都看不见）。
  let truncationCarry = null;

  const startTurn = (runId) => {
    activeTurnRunId = runId;
    turnStartedAt = Date.now();
    markSessionActivity(sessionId);  // turn 边界 = 活跃信号
    // 重置 sharedCtx 的 per-turn state
    sharedCtx.runId = runId;
    sharedCtx.counters = freshTurnCounters();
    sharedCtx.startedAt = Date.now();
    sharedCtx._cancelled = false;        // context.js cancel 幂等 flag 重置
    // 当前 turn id 写到 process.env（历史上给 proxy 透传 trace 头用；NoDesk 退役
    // 后暂无消费方，保留是因为惯性成本为零、删了想再串链路要重接）。
    // 旧的 NODESIGN_CURRENT_APP_MODEL 已随 model-ingress 重建退役：路由改为按
    // 请求 body.model 查表，天然无跨会话互写问题。
    process.env.NODESIGN_CURRENT_TURN_ID = runId;
    markRunStarted(runId);
    // 丢掉回合之外留下的半截标记：CLI 在两个回合之间还会用**主模型**打几发
    // （SUGGESTION MODE 的猜你想问、标题生成等，真路径探针实测），那些也会被
    // ingress 标成半截。不清的话下一轮一开场就吃到陈旧标记，平白续接一次
    // （用户看到 agent 没头没脑地"接着写"）。只有本回合内产生的标记才算数。
    takeUpstreamTruncation(sessionId);
    sharedCtx.emit(Events.start());
  };

  // ── 后台自发 turn 铸造（2026-07-29）──
  // SDK 自己发起的 turn（后台 Task 子代理完成 → task-notification 重新唤起 agent）
  // 没有经过 turn.js POST /turn，没人 createRun / 设 currentRunId。后果：
  //   1. AskUserQuestion 被 canUseTool 以 "no active turn" 拒掉 —— explorer 跑完
  //      准备好三张带 preview 的方向卡片，只能退化成纯文字描述（真实伤口）
  //   2. 整个回合的事件挂在上一个已结束 run 的 runId 上，前端归属混乱
  // 修法：检测到无主 turn 时铸造一个真 run record（createRun → setCurrentTurnRunId
  // → startTurn），让 run.start/run.done、AskUserQuestion answer 回路、runs 审计
  // 全部照常工作。前端 activeRun 由 run.start 设置，answer POST 天然有 runId 可用。
  const mintBackgroundTurn = (reason) => {
    // 归属：后台自发 turn 没有 req.user，用项目 owner（配额/审计口径一致）
    let ownerId = null;
    try { ownerId = getProject(projectId)?.ownerId ?? null; } catch { /* 归属查不到不挡后台回合 */ }
    const run = createRun({
      skillId,
      brief: `(后台回合：${reason})`,
      projectId,
      userId: ownerId,
      metadata: { background: true, mintReason: reason },
    });
    setCurrentTurnRunId(sessionId, run.id);
    startTurn(run.id);
    console.info(
      `[session-loop] sid=${sessionId.slice(0, 8)} minted background turn run=${run.id} (${reason})`,
    );
    return run.id;
  };


  const finishTurn = async (status, info) => {
    if (!activeTurnRunId) return;
    const runId = activeTurnRunId;
    // 取消 / 出错路径没走到上面那次 addCarry —— 在这里补上，别让续接前那一轮的账凭空消失
    // （取消掉的回合一样烧了 token，配额口径要计）
    if (truncationCarry) { sharedCtx.addCarry(truncationCarry); truncationCarry = null; }
    if (status === 'success') {
      const artifactPath = await detectArtifact(sharedCtx);
      mergeRunMetadata(runId, { sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunSucceeded(runId, { artifactPath }); } catch { /* idempotent */ }
      sharedCtx.emit(Events.done(info?.finalText || '', artifactPath, sharedCtx.snapshot ? sharedCtx.snapshot() : { counters: sharedCtx.counters }));
      // （2026-08-19 拆除：收场 recap —— 闲时精灵那句"刚才干了什么"。它唯一的
      //   产出方式是起一发写死 claude-haiku-4-5 的一次性会话，不跟随会话模型，
      //   本地/API 会话照样烧订阅额度且不进记账。闲时精灵改回写问候语，那是
      //   recap 缺席时本来就走的分支。理由全文见 lib/quick-summary.js 文件头。）
      // 首页大输入框建出来的项目名是垫的：第一轮跑完拿 SDK helper 写的会话摘要
      // 正名一次（只一次，用户改过名就不动）。失败不影响 turn。
      autoNameProjectFromSession(projectId, sessionId)
        .then((name) => {
          if (name) sharedCtx.emit({ type: 'project.renamed', projectId, name });
        })
        .catch((err) => console.warn('[auto-name]', err.message));
    } else if (status === 'cancelled') {
      // 取消掉的 turn 也烧了 token —— counters 一样落库（配额视角是漏收）
      mergeRunMetadata(runId, {
        aborted: true, abortReason: info?.reason || 'user_cancel',
        sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunFailed(runId, `cancelled: ${info?.reason || 'user_cancel'}`); } catch { /* */ }
      sharedCtx.emit({ type: 'run.cancelled', reason: info?.reason || 'user_cancel' });
    } else if (status === 'error') {
      mergeRunMetadata(runId, {
        sdkSessionId: sharedCtx.sdkSessionId, ...sharedCtx.counters,
        errorCode: info?.code, errorMessage: info?.message,
      });
      setRunMetrics(runId, sharedCtx.counters);
      setRunModelUsage(runId, sharedCtx.counters.modelUsage);
      try { markRunFailed(runId, info?.message || 'unknown'); } catch { /* */ }
      sharedCtx.emit(Events.error(info?.message || 'unknown', info?.code, info?.stack));
    }
    // 工作区一轮一条 commit（2026-08-08）。
    //
    // 在这之前**只有"用户在画布上直接编辑 HTML"那一条路会提交**（canvas.js 的
    // PUT），agent 写文件、mv 文件一次 commit 都不产生 —— 项目仓里基本只有一条
    // init。现在它承担一件具体的活：画布物件的 id 就是工作区相对路径，agent
    // 背着画布 `mv` 一个文件，那张卡的坐标 / 关系线 / 批注全断，而且因为
    // board.objects 是稀疏的，断掉的条目**清都清不掉**。git 的改名检测是唯一
    // 不用引入第二个真相源就能认出"这是同一个东西换了位置"的办法
    // （见 board-store.js 的 reconcileBoardRenames），而它需要有 commit 可比。
    //
    // 失败只 warn：一个 commit 落不下不该让已经跑完的 turn 变成失败。
    // **等它落完再往下走**：对账器（reconcileBoardRenames）靠这条 commit 才看得见
    // agent 这一轮 mv 了什么。不等的话，turn 完成事件触发的那次产物重扫可能跑在
    // commit 前面，改名这一轮就漏掉了。
    await commitWorkspace(projectId, sessionId, `turn ${status}: ${new Date().toISOString()}`, { author: 'agent' })
      .catch((err) => console.warn('[git] turn commit failed:', err.message));

    // 黑板草稿兜底落定（2026-08-23）：agent 这一轮 write_on_board 画图留下的 staging
    // 物件，没调 edit_board commit 也在回合结束时变实 —— 草稿态是"正在画"的信号，
    // 回合都结束了还半透明就是幽灵。取消/出错同样落定：画了就是画了。
    if (projectId) {
      try {
        const { committed } = await commitStaging(projectId);
        if (committed > 0) sharedCtx.emit({ type: 'board.updated', sessionId: null, summary: `黑板草稿落定 ${committed} 件` });
      } catch (err) { console.warn('[board] commitStaging failed:', err.message); }
    }

    activeTurnRunId = null;
    turnStartedAt = 0;
    markSessionActivity(sessionId);  // turn 结束 = 活跃信号；下次 idle 计时重置
    // 让出 currentRunId。排队的下一 turn **不在这里按计数晋升**（2026-08-20 起）——
    // 由它自己的回显来认领（见 for-await 循环头的回显锚）。老接力在 CLI 并轮后
    // 永久错一格（run 记账错位案，见 active-runs.js）。
    releaseCurrentTurnRunId(sessionId);
    // 清掉 turn id 环境变量；下个 turn 的 startTurn 会重设
    delete process.env.NODESIGN_CURRENT_TURN_ID;
  };

  // ── idle timeout 兜底 ──
  // 用户关 tab 后 WS-disconnect grace 是常规清理路径；这里再加一道：
  // session 超过 IDLE_TIMEOUT 无任何活动（push message / turn 边界）→ 自动关。
  // 防止"WS 还在但 user 走开几小时"的隐性占用。
  const IDLE_TIMEOUT_MS = Number(process.env.NODESIGN_SESSION_IDLE_MS) || 30 * 60_000;
  const IDLE_SCAN_INTERVAL_MS = Math.min(5 * 60_000, IDLE_TIMEOUT_MS);
  const idleScanTimer = setInterval(() => {
    const last = getSessionLastActivity(sessionId);
    if (last == null) return;  // session 已被 unregister，scan 等会儿自然结束
    if (Date.now() - last > IDLE_TIMEOUT_MS) {
      console.info(`[session-loop] sid=${sessionId.slice(0, 8)} idle > ${IDLE_TIMEOUT_MS}ms, closing`);
      closeQuerySession(sessionId, 'idle_timeout');
    }
  }, IDLE_SCAN_INTERVAL_MS);
  idleScanTimer.unref?.();

  // ── main stream loop ──

  let stream;
  try {
    stream = query({ prompt: inputQueue, options: sdkOptions });
    attachSessionQuery(sessionId, stream);

    // 铅笔精灵的手写短句（2026-08-14 日记本批）：assistant 文本一到就把第一
    // 小句压成一行推上画布，纯本地整形、零成本零延迟、同步出结果。
    // 子代理的话不上精灵 —— 它们有自己的舞台便利贴。
    // （2026-08-19 拆除后半段：原来这里还起一发 haiku 精修、到货再补一发
    //   refined:true 覆盖底稿。那发写死走订阅不跟随会话模型 —— 见
    //   lib/quick-summary.js 文件头。现在一 round 只有这一发。）
    let lastSummarySrc = '';
    const maybeSpriteSummary = (message) => {
      if (message.parent_tool_use_id) return;
      const text = (message.message?.content || [])
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text).join('\n').trim();
      if (!text || text === lastSummarySrc) return;
      lastSummarySrc = text;
      const line = clampFirstClause(text);
      if (line) sharedCtx.emit(Events.spriteSummary(sharedCtx.counters.turns, line));
    };

    // emitContextUsage：fire-and-forget per assistant message
    let usageInFlight = false;
    const emitContextUsage = () => {
      if (usageInFlight) return;
      usageInFlight = true;
      stream.getContextUsage()
        .then((usage) => { if (usage) sharedCtx.emit(Events.contextUsage(usage, sharedCtx.appModel)); })
        .catch(() => { /* fail-soft */ })
        .finally(() => { usageInFlight = false; });
    };

    // ── 半截续接（08-21 晚）──
    // Zen 会在模型说到一半时把流掐了（无 finish_reason / 私货 finish 如 network_error），
    // 正文已经吐了一半。转换层照旧按 end_turn 交付（假上游实测：有可见输出后再发 error 事件
    // CLI **不重试**，只会把半截 + "Server error mid-response" 一起判 is_error 丢给用户），
    // 于是半截答案就成了最终答案 —— agent 说半句话就收工。08-21 当天生产 4 次。
    //
    // 治法跟 OpenCode 1.18.21 对 unknown finish 的做法一样：半截那段原样留在历史里，
    // 补一条用户消息让模型接着说，同一个 run 内再跑一轮（pushUnclaimedMessage 不认领 run）。
    // 上限 MAX_CONTINUATIONS：上游持续半截时别把回合拖成无限循环。
    // ⚠️ 别写 `Number(env) || 2`：设 0 想紧急关掉这个功能会落回 2（fable 评审 P2）
    const envMax = Number(process.env.NODESIGN_TRUNCATION_CONTINUATIONS);
    const MAX_CONTINUATIONS = Number.isFinite(envMax) && envMax >= 0 ? envMax : 2;
    const continuationCounts = new Map();   // runId → 已续接次数
    const maybeContinueTruncated = () => {
      const mark = takeUpstreamTruncation(sessionId);
      if (!mark) return false;
      const runId = activeTurnRunId;
      if (!runId) return false;
      // 只认**本回合内**产生的标记。CLI 在回合之间还会用主模型打请求（猜你想问 / 标题），
      // 上游一慢它们可能迟到；startTurn 那次清扫挡不住迟到的（fable 评审 P2）。
      if (turnStartedAt && mark.at && mark.at < turnStartedAt) {
        console.warn(`[session-loop] sid=${sessionId.slice(0, 8)} 丢弃回合外的半截标记（${mark.reason}，早于本回合开始）`);
        return false;
      }
      const used = continuationCounts.get(runId) || 0;
      const sidShort = sessionId.slice(0, 8);
      if (used >= MAX_CONTINUATIONS) {
        console.warn(`[session-loop] sid=${sidShort} run=${runId} 半截续接已用满 ${used} 次（${mark.reason}），按现状收尾`);
        sharedCtx.emit(Events.notification('upstream_truncated', `上游连着把回答掐断了 ${used + 1} 次，这段可能没说完。重发一次试试。`, 'warn'));
        return false;
      }
      const pushed = pushUnclaimedMessage(sessionId, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: CONTINUATION_PROMPT }] },
        parent_tool_use_id: null,
      });
      if (!pushed) return false;
      continuationCounts.set(runId, used + 1);
      // 第一轮的账要结转，否则被下一个 result 的 absorbResult 整个覆盖（fable 评审 P0）
      truncationCarry = sharedCtx.takeCarry();
      console.warn(`[session-loop] sid=${sidShort} run=${runId} 上一条回复被上游掐断（${mark.reason}）→ 自动续接第 ${used + 1}/${MAX_CONTINUATIONS} 次`);
      sharedCtx.emit(Events.notification('upstream_truncated', '上游把回答掐断了，正在让它接着说完。', 'info'));
      return true;
    };

    for await (const message of stream) {
      // 每条 SDK message 都是活跃信号 —— 老逻辑只有 push / turn 边界算活跃，
      // 单个 turn 跑超 30 分钟（多页 deck + 子代理）会被 idle timeout 掐死（P8）
      markSessionActivity(sessionId);

      // ── 回显锚（2026-08-20，run 记账错位案）──
      // CLI 开了 --replay-user-messages：我们 push 的每条用户消息会在**真正被并进
      // 对话的那一刻**回显回来（带 push 时盖的 uuid）。按 uuid 认领它的 run：
      //   promoted → 它的 turn 现在开始（下面的边界检测接手 startTurn）
      //   merged   → 它被并进了正在跑的这一轮，就地关账，不另起 turn
      // 机制与探针证据见 active-runs.js claimRunByUuid 上方的注释。
      if (message.type === 'user' && message.uuid && !message.parent_tool_use_id) {
        const claim = claimRunByUuid(sessionId, message.uuid);
        if (claim?.outcome === 'merged') {
          closeMergedRun({ runId: claim.runId, intoRunId: claim.intoRunId, sessionId, sdkSessionId: sharedCtx.sdkSessionId, eventBus });
        } else if (claim?.outcome === 'unknown') {
          console.warn(`[session-loop] sid=${sessionId.slice(0, 8)} replayed run=${claim.runId} not pending nor current (ignored)`);
        }
        if (claim) publishQueueDepth(eventBus, sessionId);
      } else if (
        !activeTurnRunId && !getCurrentTurnRunId(sessionId) && getPendingRunCount(sessionId) > 0
        && (message.type === 'assistant' || message.type === 'stream_event')
      ) {
        // 回显锚缺席（CLI 没回显就开始说话了）→ FIFO 兜底，别让排队的 run 没人认领。
        // 正常运行不该走到这里；走到了就是 CLI 行为变了，warn 让人看见。
        const promoted = promoteNextPendingRunId(sessionId);
        console.warn(`[session-loop] sid=${sessionId.slice(0, 8)} replay anchor missing, FIFO fallback promoted run=${promoted}`);
      }

      // 检测 turn 边界：currentRunId 切换 → 新 turn
      const cid = getCurrentTurnRunId(sessionId);
      if (cid && cid !== activeTurnRunId) {
        // 新 turn 开始（前一 turn 应该已 finishTurn — 防御性兜底）
        if (activeTurnRunId) {
          await finishTurn('error', { message: 'turn boundary skipped without result', code: 'TURN_LEAK' });
        }
        startTurn(cid);
      } else if (!cid && !activeTurnRunId && isBackgroundTurnOpener(message)) {
        // SDK 自发 turn（后台 Task 完成通知唤起 agent）—— 没有用户消息、没有
        // runId。铸造一个让整回合事件有正确归属（否则全挂在上一个已结束 run 上）。
        mintBackgroundTurn(`sdk_${message.type}`);
      }

      // 开局契约自检：init 每次到达都对账（新建/resume 各来一次）
      if (message.type === 'system' && message.subtype === 'init') {
        // 开局契约自检（空壳钩子灭门案第 3 层）—— 全文见 init-contract.js
        assertInitContract(message, { sessionId, projectId, isResume, initialPermissionMode, platform, sdkModel, nodesignServer });
      }

      handleSDKMessage(sharedCtx, message);

      if (message.type === 'assistant') {
        emitContextUsage();
        maybeSpriteSummary(message);
      }

      if (message.type === 'result') {
        // 计量断链修复（2026-07-30）：result message 的 usage/total_cost_usd 是
        // 本 turn 真增量，从前直接丢弃 → runs 表 token counters 常年全 0。
        // cancelled 也吸收 —— 取消掉的 turn 已经烧了 token，配额要计
        sharedCtx.absorbResult(message);
        // 上游自报费用（/zen/go 的 cost）覆盖 SDK/表价算出来的数：取走 ingress 本轮累计（没报就 null，不动）
        sharedCtx.applyUpstreamBilling(takeUpstreamBilling(sessionId));
        // 半截续接过的回合：把续接前那一轮的账加回来（absorbResult 是赋值不是累加）。
        // 放在 applyUpstreamBilling 之后 —— 上游自报 cost 只覆盖**本轮**那条，加完 carry 才是整回合的总账。
        if (truncationCarry) { sharedCtx.addCarry(truncationCarry); truncationCarry = null; }
        const isCancelled = message.terminal_reason === 'aborted_streaming'
          || message.terminal_reason === 'aborted_tools';

        if (isCancelled) {
          await finishTurn('cancelled', { reason: message.terminal_reason });
        } else if (message.subtype === 'success' && !message.is_error && maybeContinueTruncated()) {
          // 半截续接：这一轮的收尾响应是"说到一半被上游掐了"，已经推了续接消息，
          // **不结账**（同一个 run 接着跑，下一个 result 才是真收尾）。
        } else if (message.subtype === 'success' && message.is_error) {
          // 08-21 晚：API 层以 4xx 收场（如 ingress 连续失败止损回的 400）时，SDK 给的是
          // subtype=success + is_error=true + result=错误文案（假上游实测）。以前走下一分支当成功，
          // run 标 succeeded、错误文案当最终回答。现在按 error 结账，文案原样给用户。
          await finishTurn('error', { message: message.result || 'API error', code: 'API_ERROR' });
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
        publishQueueDepth(eventBus, sessionId);
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
      } else if (initialRunId) {
        // 错误发生在 startTurn 之前（如 SDK query() 启动权限冲突 / workspace.ensure
        // 抛错等）→ activeTurnRunId 还是 null，sharedCtx.runId 仍是占位符
        // '__session_pending__'。直接 emit run.error 会让 enriched event 带这个占位
        // runId，前端 stale guard `evt.runId !== liveRunId` 把事件吞掉 → 用户看到
        // "完全没反应"。修：手动把 sharedCtx.runId 设到本次 turn 的 initialRunId 让
        // emit 出去的 run.error 带正确 runId 让前端能渲染错误。
        sharedCtx.runId = initialRunId;
        try { markRunFailed(initialRunId, err.message || 'unknown'); } catch { /* ignore */ }
      }
      sharedCtx.emit(Events.error(err.message, err.code, err.stack));
      throw err;
    }
  } finally {
    clearInterval(idleScanTimer);
    unregisterIngressSession(sessionId);   // API 会话的 fast 兜底路由配对注销（订阅会话 noop）
    if (relaySid) unbindSessionFromRelay(relaySid);   // relay 上的登记配对注销
    unregisterSessionNotice(sessionId, noticeHandler);   // ingress → 会话的通知通道配对注销（按身份，别删掉新会话的）
    takeUpstreamTruncation(sessionId);     // 半截标记跟会话同生命周期，别留
    clearSessionFlights(sessionId); clearStageStatus(projectId);   // 在飞台账 + 台上一览，都跟会话同寿命
    // 带 token 比对：sid 若已被新 register 占用（closeQuerySession 已同步让位 +
    // 用户重发起新 runSession），unregister 看到 _token 不匹配 → noop 不误删新 entry
    unregisterQuerySession(sessionId, sessionToken);
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
  // SDK 将 JSONL 存在 CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl
  // 编码规则（grep 自 sdk.mjs）：所有非字母数字字符转 '-'
  const encodedCwd = sessionRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const globalJsonl = path.join(platform.claudeConfigDir, 'projects', encodedCwd, `${sessionId}.jsonl`);
  try {
    await fs.access(globalJsonl);
    return true;
  } catch { /* not at global location */ }

  // fallback：检查本地 .claude/projects/（兼容旧行为 / sandbox 模式）
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
