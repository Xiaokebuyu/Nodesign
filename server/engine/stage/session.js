/**
 * engine/stage/session.js —— 演出进程：一个独立的 SDK 会话，专职演戏。
 *
 * ## 为什么是独立进程，不是子代理
 *
 * 决定性的一条：**子代理没法不吃项目 CLAUDE.md**（SDK 强制注入、omitClaudeMd 透不过去，
 * 08-26 底账），而站主要求 RP 模式不加载它 —— 那是设计工作台的档案，进了戏就是污染。
 * 独立会话 `settingSources: []` 一刀切干净。
 *
 * "宿主够不着子代理"**不是**决定性理由（09-05 我一开始这么说，后来对账推翻）：
 * 上行确实投不进（Query 接口 14 个方法没有发消息的；streamInput 带 parent_tool_use_id
 * 实测不路由），但邮差范式绕得过（服务端 → 一个挂在 await_user 上的角色 → 目标），
 * 而且下行本来就直连（forwardSubagentText 后子代理的字比主 agent 先到宿主）。
 * 代价是内存：独立进程 300-500MB，子代理增量只有 8MB。token 上只贵两千。
 *
 * ## 一人分饰多角，不做调度
 *
 * 台上所有人由这一个会话写。机器**不**决定这一拍轮到谁开口 —— 那是 2026-08-29
 * 删掉的 scene.js 干的事，结论是"谁接这一拍"归 agent 当场判断。这里只做两件：
 * 把用户的话送进去，把它写出来的东西送出来。
 *
 * ## 冷热分区是成本纪律，不是编排
 *
 * 系统层放不变的东西（演出教义 + 台面规矩），每轮变的走消息体。这不是为了调度，
 * 是为了让前缀能复用 —— 酒馆四方世界卡实测 75k/95k 输入、缓存读恒为 0，根因是
 * 世界书按 order 插进上下文中部让后续整体位移，一回合约 $1。冻错一样就全吐回去。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from './input-queue.js';

/**
 * 演出进程的工具面 —— **黑名单，不是白名单**。
 *
 * ⛔ 别改回 `tools: [...]` 白名单：2026-09-05 实测它会把地基从 15,527 撑到
 * 109,097 token（7 倍），因为白名单模式关掉了工具延迟加载，把在场每个 MCP
 * 服务器的完整 schema 全展开进系统提示词 —— 而且**它一个 MCP 工具都没挡住**
 * （76 个原封不动）。黑名单同样限得住权，地基 15,392，一个 token 不涨。
 */
export const STAGE_DENY = Object.freeze([
  // 安全边界：台上的人碰不到工作区，也不出网
  'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
  // 一人分饰多角是定案，不派子代理、不跨会话寄信
  'Agent', 'SendMessage', 'ListAgents', 'TaskOutput', 'TaskStop', 'ReportFindings',
  // 别的产线的件，演戏一个都用不上，留着只是每件一份 schema 的白账
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor', 'RemoteTrigger',
  'PushNotification', 'Workflow', 'DesignSync', 'EnterWorktree', 'ExitWorktree',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  // 宿主机器上挂着的外部 MCP（Canva / Notion / …）—— 我们自己的 nodesign 服务器
  // 走 mcpServers 显式挂，不受这条影响
  'mcp__claude_ai_*', 'mcp__plugin_*', 'mcp__codex*', 'mcp__websearch*',
]);

/**
 * 砍剩下的（2026-09-05 实测）：Read / Glob / Grep / Skill / ToolSearch 五件，
 * 地基 6,660 token。留 Skill 是为了 story-voice / story-craft 那两个包。
 *
 * 参照：08-29 实测 SDK 子代理的固定地基是 4300-4500 token。所以独立进程在
 * **token 上只比子代理贵两千**，贵的自始至终只有内存（400MB 对 8MB）。
 */

/**
 * @param {object} opts
 *   projectId / cwd            工作区
 *   systemPrompt               冻结区：演出教义 + 台面规矩（不放每轮会变的东西）
 *   model                      不传走默认（调用方给的应当是 SDK 视角的名字，见 resolveSdkSpoofModel）
 *   env                        交给 SDK 子进程的环境（通路 / 凭据目录由 manager 按模型表拼，这里不猜）
 *   sessionId                  SDK 会话 id（manager 给一个新 UUID；ingress 按它路由）
 *   maxBudgetUsd               这一场的封顶（可选）
 *   mcpServers / plugins / skills / hooks 交给调用方拼，这里不猜
 *   onEvent({type,...})        init / text / tool / turn_end / error
 */
export class StageSession {
  #q = null;
  #inbox = new InputQueue();
  #opts;
  #onEvent;
  #running = false;
  #busy = false;
  #pump = null;
  #sdkSessionId = null;

  constructor(opts) {
    this.#opts = opts;
    this.#onEvent = opts.onEvent || (() => {});
  }

  get running() { return this.#running; }
  /** 正在写这一拍（用来拦"上一拍还没写完又来一句"，以及给前端显示状态） */
  get busy() { return this.#busy; }
  /** SDK 自报的 session_id（system/init 之后才有） */
  get sdkSessionId() { return this.#sdkSessionId; }
  /** 排着还没轮到的话 */
  get queued() { return this.#inbox.depth; }

  start() {
    if (this.#running) return;
    const o = this.#opts;
    this.#q = query({
      prompt: this.#inbox,
      options: {
        cwd: o.cwd,
        ...(o.model ? { model: o.model } : {}),
        ...(o.env ? { env: o.env } : {}),
        ...(o.sessionId ? { sessionId: o.sessionId } : {}),
        ...(o.maxBudgetUsd ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
        systemPrompt: o.systemPrompt,
        // 一个都不加载（站主 2026-09-05 拍板）：RP 模式下项目 CLAUDE.md 是设计
        // 工作台的东西，进了戏就是污染。演出要的设定全部写进 systemPrompt，
        // 上一场记住的事由 stage/memory/INDEX.md 接回去。
        // 顺带也挡掉了 'user'（宿主机器的 ~/CLAUDE.md 和使用者的私人记忆）。
        settingSources: o.settingSources || [],
        disallowedTools: o.disallowedTools || STAGE_DENY,
        ...(o.mcpServers ? { mcpServers: o.mcpServers } : {}),
        // 技能包：只给演出侧那几个（manager 挑），设计产线的描述一个字不进这份地基
        ...(o.plugins ? { plugins: o.plugins } : {}),
        ...(o.skills ? { skills: o.skills } : {}),
        ...(o.hooks ? { hooks: o.hooks } : {}),
        permissionMode: o.permissionMode || 'bypassPermissions',
        includePartialMessages: true,     // 要逐字流，台上出字是体验的一部分
        stderr: (d) => console.error('[stage/stderr]', String(d).trim()),
      },
    });
    this.#running = true;
    this.#pump = this.#consume();
  }

  /** 用户对台上说一句 —— 这条路上没有主 agent。 */
  say(text, { about = null } = {}) {
    if (!this.#running) throw new Error('stage not started');
    const content = about ? `${text}\n\n（此刻：${about}）` : text;
    this.#inbox.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    });
    return { queued: this.#inbox.depth, busy: this.#busy };
  }

  async #consume() {
    try {
      for await (const m of this.#q) {
        if (m.type === 'system' && m.subtype === 'init') {
          this.#sdkSessionId = m.session_id || null;
          this.#onEvent({ type: 'init', sessionId: this.#sdkSessionId, model: m.model || null, tools: m.tools || [] });
          continue;
        }
        if (m.type === 'stream_event') {
          const d = m.event?.delta;
          if (d?.type === 'text_delta' && d.text) this.#onEvent({ type: 'text', text: d.text });
          continue;
        }
        if (m.type === 'assistant') {
          this.#busy = true;
          for (const b of m.message?.content || []) {
            if (b.type === 'tool_use') this.#onEvent({ type: 'tool', name: b.name, input: b.input });
          }
          continue;
        }
        if (m.type === 'result') {
          this.#busy = false;
          this.#onEvent({
            type: 'turn_end',
            usage: m.usage || null,
            costUsd: m.total_cost_usd ?? null,
            error: m.subtype !== 'success' ? m.subtype : (m.is_error ? 'api_error' : null),
            // 整条 result 交出去：计量要拿 modelUsage 做差分（AgentContext.absorbResult 那套），
            // 这里不替它挑字段 —— 挑了就是第二份口径
            result: m,
          });
        }
      }
    } catch (err) {
      this.#onEvent({ type: 'error', error: String(err?.message || err) });
    } finally {
      this.#running = false;
      this.#busy = false;
    }
  }

  async stop() {
    if (!this.#running) return;
    this.#inbox.close();
    try { await this.#q?.interrupt?.(); } catch { /* 已经在退了 */ }
    await this.#pump?.catch(() => {});
    this.#running = false;
  }
}
