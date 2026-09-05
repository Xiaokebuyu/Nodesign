/**
 * engine/stage/session.js —— 演出进程：一个独立的 SDK 会话，专职演戏。
 *
 * ## 为什么是独立进程，不是子代理
 *
 * 子代理便宜得多（同一个 binary 里跑，增量约 8MB，独立进程 300-500MB），但
 * **宿主够不着**。2026-09-05 逐口验过：Query 接口 14 个方法没有一个能发消息；
 * 宿主控制协议只有 stop_task 没有 send_to_task；streamInput 带 parent_tool_use_id
 * 实测不路由（投给子代理的话被主 agent 接走了）。想直连子代理只剩两条：让它挂在
 * 自定义 MCP 工具上等（await_user，2026-08-26 建过），或者就是这里 —— 起一个
 * 宿主自己拿着输入队列的会话。
 *
 * 反过来，**下行本来就是直连的**：forwardSubagentText 之后子代理的字实时到宿主，
 * 早于主 agent 知道这件事。所以这个模块解决的只有上行。
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
  'Bash', 'Write', 'Edit', 'NotebookEdit',   // 台上的人碰不到工作区
  'WebFetch', 'WebSearch',                   // 演戏不需要出网
  'Agent', 'SendMessage',                    // 不派子代理：一人分饰多角是定案
]);

/**
 * @param {object} opts
 *   projectId / cwd            工作区
 *   systemPrompt               冻结区：演出教义 + 台面规矩（不放每轮会变的东西）
 *   model                      不传走默认
 *   mcpServers / hooks / tools 交给调用方拼，这里不猜
 *   onEvent({type,...})        text / tool / turn_end / error
 */
export class StageSession {
  #q = null;
  #inbox = new InputQueue();
  #opts;
  #onEvent;
  #running = false;
  #busy = false;
  #pump = null;

  constructor(opts) {
    this.#opts = opts;
    this.#onEvent = opts.onEvent || (() => {});
  }

  get running() { return this.#running; }
  /** 正在写这一拍（用来拦"上一拍还没写完又来一句"，以及给前端显示状态） */
  get busy() { return this.#busy; }

  start() {
    if (this.#running) return;
    const o = this.#opts;
    this.#q = query({
      prompt: this.#inbox,
      options: {
        cwd: o.cwd,
        ...(o.model ? { model: o.model } : {}),
        systemPrompt: o.systemPrompt,
        // 'project' 一项都不能少 —— 台面规矩住在项目 CLAUDE.md 里，
        // 传 [] 会连它一起关掉（SDK: "Must include 'project' to load CLAUDE.md"）。
        // 不要 'user'：那会把宿主机器的 ~/CLAUDE.md 和使用者的私人记忆吃进戏里，
        // 既是 7k token 的白账，也是不该有的越界。
        settingSources: o.settingSources || ['project'],
        disallowedTools: o.disallowedTools || STAGE_DENY,
        ...(o.mcpServers ? { mcpServers: o.mcpServers } : {}),
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
            error: m.subtype !== 'success' ? m.subtype : null,
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
