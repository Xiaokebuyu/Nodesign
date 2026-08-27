/**
 * lib/ingress/openai-chat.js — Anthropic Messages ⇄ OpenAI Chat Completions 协议转换（2026-08-21）
 *
 * ## 为什么有这层
 *
 * SDK binary 永远说 Anthropic Messages；model-ingress 以前只会**转发**（上游也说 Anthropic）。
 * OpenCode Zen 整家**只有 OpenAI chat 格式能用工具**（它给模型架的 /v1/messages 桥一带 tools
 * 就 [1210]，08-21 拿当时的 Ox Alpha 四种写法探死），newapi 中转站、NVIDIA build 同病。所以协议
 * 映射得自己做 —— 不上 gproxy（外部守护进程 + 四个已知洞 + 第二个 quirk 真相源），在 ingress 里按
 * 上游 `protocol: 'openai-chat'` 分岔，其余上游一字不动。
 * ⭐ 逼出这层的 Ox 08-26 就下架了，这层照常服务着 zen/zenGo/nvidia 三家 —— **闸和转换层才是耐久
 * 资产，模型行是插件**（08-21 加 Ox 时写下的判断，一周后应验）。
 *
 * ## 映射要点（都是探针实测逼出来的，不是抄规范）
 *
 * - tool_result 里的图一律提到紧随其后的 user 消息里：tool 角色消息里放 image_url 上游挂死 120s
 * - tool_result 必须紧跟 assistant 的 tool_calls：Anthropic 一条 user 消息里 tool_result 与
 *   文本混排 → 先吐 role:tool 条，再吐 role:user 条（文本 + 提出来的图）
 * - thinking 块不回传（没有 signature 机制）；assistant 历史里的 thinking 合成 reasoning_content
 *   （models.dev 标 interleaved.field=reasoning_content，回传给模型接着想）
 * - Anthropic thinking 参数 → reasoning_effort（行内 reasoningEffort；zen 系普遍是 low|high|max 三档，**没有 medium**）
 * - 流式：OpenAI chunk → 合成 message_start / content_block_* / message_delta / message_stop；
 *   usage 在最后一个 chunk（stream_options.include_usage），Anthropic 口径 input 不含 cache 命中
 * - stop_reason：tool_calls→tool_use · stop→end_turn · length→max_tokens；有 tool_calls 但
 *   finish 说 stop 也算 tool_use（CLI 认块不认 stop_reason，但别给它矛盾信号）
 * - **上游私货 finish_reason**（08-21）：Zen 会吐 `finish_reason:"network_error"`（它到模型
 *   提供方那一跳断了），实测形态是挂 185 秒或快败 6~9 秒后零 delta 收场。这种值不在
 *   STOP_MAP 里，以前落 `|| 'end_turn'` = 把上游故障包装成"成功的空回合"，CLI 只能补一句
 *   "你上一轮没有可见输出"再跑一整轮（真实代价：185s 空转 + 一整轮重来）。现在改成发
 *   error 事件 —— **假上游实验实测：CLI 收到流中 error 会在 0.2~0.4 秒内原样重发，用户
 *   全程无感**，所以重试交给它，ingress 不自建（两层重试互不知情，只会让失败会话多占并发槽）
 * - **refusal 字段**：OpenAI 的拒答走 `delta.refusal` / `message.refusal` 而不是 content，
 *   我们以前整个没读 = 又一种"零可见输出的假成功"。当文本吐出去即可。
 *   ⚠️ 别顺手把 content_filter 映射成 Anthropic 的 `refusal` stop_reason（gproxy 那么写）：
 *   实测 CLI 见到 stop_reason=refusal 会弹「Start a new session」并丢弃随流正文，
 *   会话直接判死 —— 现有的 content_filter→end_turn 在 Claude Code 语境下才是对的
 */
import { Transform } from 'node:stream';
import { upstreamCostOf } from './upstream-billing.js';

const STOP_MAP = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens', content_filter: 'end_turn', function_call: 'tool_use' };

/** finish_reason 是不是上游私货（不在 STOP_MAP 里）。null/undefined 不算 —— 那是"没给收尾原因"，另有分支 */
const isAlienFinish = (finish) => Boolean(finish) && !(finish in STOP_MAP);

/**
 * 「半截」判据（08-21 晚，对齐 OpenCode 1.18.21 的 unknown-finish 续接）：**已经说出正文、
 * 却没有可信的收尾原因**（无 finish_reason = 上游把流掐了；私货 finish 如 network_error）。
 * 这种响应我们照旧按 end_turn 交付（假上游实测：有可见输出后再发 error 事件 CLI **不重试**，
 * 只会把半截 + "Server error mid-response" 一起交给用户并判 is_error），
 * 但要标记出来让 session-loop 自动续接一轮 —— 否则半截答案就是最终答案。
 *
 * ⚠️ 出过 tool_call 的不算：那种半截 CLI 自己会治（坏 JSON → __unparsedToolInput →
 * 本地合成 InputValidationError tool_result → 模型自己重来，实测 8s 内自愈）。
 * 对它续接等于叠加，实测还会把回合拖进 max_turns。
 *
 * @returns {string|null} 原因串（进日志/审计），null = 不是半截
 */
export function truncationReason({ finish, sawText, sawToolCall, doneSeen = false }) {
  if (!sawText || sawToolCall) return null;
  // ⭐ 上游好好地发了 `[DONE]` 只是末块没带 finish_reason（OpenAI 兼容实现里不罕见）：
  // 那是**收完了**，不是被掐。少这一条判据的话，换一家这种脾气的上游就会每一轮都平白
  // 续接到封顶 —— 3 倍 token、3 倍延迟，外加一条冤枉用户的告警（fable 评审 P1，探针复现过）。
  if (!finish && doneSeen) return null;
  if (!finish) return 'no finish_reason';
  if (isAlienFinish(finish)) return `finish_reason='${finish}'`;
  return null;
}

function textOfBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

function imagePart(block) {
  const src = block?.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  if (src.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

/** tool_result.content → (text, images[])。图不留在 tool 消息里（上游挂死），拿出来给调用方放进 user 消息 */
function splitToolResult(block) {
  const images = [];
  let text = '';
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    const parts = [];
    for (const inner of block.content) {
      if (inner?.type === 'text') parts.push(inner.text || '');
      else if (inner?.type === 'image') { const p = imagePart(inner); if (p) { images.push(p); parts.push('[image: see the image attached to the following user message]'); } }
    }
    text = parts.join('\n');
  }
  if (block.is_error && text) text = `[tool error] ${text}`;
  return { text, images };
}

/**
 * @param {object} parsed Anthropic Messages body（已过 transformForUpstream：model 已是 wireModel）
 * @param {{ reasoningEffort?: string, maxOutput?: number }} opts
 * @returns {object} OpenAI chat.completions body
 */
export function toOpenAIChatRequest(parsed, opts = {}) {
  const out = { model: parsed.model, messages: [] };
  const sys = textOfBlocks(parsed.system);
  if (sys) out.messages.push({ role: 'system', content: sys });

  for (const msg of parsed.messages || []) {
    if (!msg) continue;
    if (msg.role === 'assistant') {
      const m = { role: 'assistant', content: '' };
      if (typeof msg.content === 'string') m.content = msg.content;
      else if (Array.isArray(msg.content)) {
        const texts = []; const thoughts = []; const calls = [];
        for (const b of msg.content) {
          if (b?.type === 'text') texts.push(b.text || '');
          else if (b?.type === 'thinking' && b.thinking) thoughts.push(b.thinking);
          else if (b?.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
        // 只有 thinking（被打断的回合）时 content 为空且无 tool_calls，部分 OpenAI 兼容后端会 400 —— 补个占位
        m.content = texts.join('\n') || (calls.length ? '' : '(no text)');
        if (thoughts.length) m.reasoning_content = thoughts.join('\n');
        if (calls.length) m.tool_calls = calls;
      }
      out.messages.push(m);
      continue;
    }
    // user：tool_result 先出（紧跟 tool_calls），其余文本/图合成一条 user
    if (typeof msg.content === 'string') { out.messages.push({ role: 'user', content: msg.content }); continue; }
    if (!Array.isArray(msg.content)) continue;
    const toolMsgs = []; const parts = []; const lifted = [];
    for (const b of msg.content) {
      if (b?.type === 'tool_result') {
        const { text, images } = splitToolResult(b);
        toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text || '(empty)' });
        lifted.push(...images);
      } else if (b?.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b?.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
      else if (b?.type === 'document') parts.push({ type: 'text', text: '[document attachment omitted: upstream cannot read documents]' });
    }
    out.messages.push(...toolMsgs);
    const all = [...parts, ...lifted];
    if (all.length) {
      const onlyText = all.every(p => p.type === 'text');
      out.messages.push({ role: 'user', content: onlyText ? all.map(p => p.text).join('\n') : all });
    }
  }

  if (Array.isArray(parsed.tools)) {
    const fns = parsed.tools
      .filter(t => t && t.name && (t.type === undefined || t.type === 'custom'))
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
    if (fns.length) out.tools = fns;
  }
  const tc = parsed.tool_choice;
  if (tc && out.tools) {
    if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else out.tool_choice = 'auto';
  }

  const cap = opts.maxOutput || 131072;
  out.max_tokens = Math.max(1, Math.min(Number(parsed.max_tokens) || cap, cap));
  if (typeof parsed.temperature === 'number') out.temperature = parsed.temperature;
  if (typeof parsed.top_p === 'number') out.top_p = parsed.top_p;
  if (Array.isArray(parsed.stop_sequences) && parsed.stop_sequences.length) out.stop = parsed.stop_sequences.slice(0, 4);
  if (parsed.stream) { out.stream = true; out.stream_options = { include_usage: true }; }
  // 档位只看行内 reasoningEffort：Anthropic 的 thinking 字段在进到这里之前已被 transformForUpstream
  // 按行内 thinking:'strip' 删掉（fable 评审抓的：以前以它存在为前提，档位从没发出去过）
  if (opts.reasoningEffort && parsed.thinking?.type !== 'disabled') out.reasoning_effort = opts.reasoningEffort;
  return out;
}

function usageFromOpenAI(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const cached = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  const prompt = Number(u.prompt_tokens) || 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: Number(u.completion_tokens) || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

function parseArgs(s) {
  if (s == null || s === '') return {};
  try { return JSON.parse(s); } catch { return { _raw_arguments: String(s) }; }
}

/**
 * 非流式：OpenAI chat.completion → Anthropic message。
 * 返回 null = 别包成成功回合，调用方回 502（CLI 会重试）。两种情况返 null：
 *   ① 没有 choices（上游 200 但给了错误体/空体）
 *   ② finish_reason 是上游私货且零可见输出（流式那条 `_finish` 的孪生洞，同一张 STOP_MAP）
 */
export function fromOpenAIChatResponse(json) {
  if (!json || !Array.isArray(json.choices) || !json.choices.length) return null;
  const choice = json.choices[0] || {};
  const m = choice.message || {};
  const content = [];
  // 思考文本的字段名各家不一样：zen 系是 reasoning_content（models.dev 的 interleaved.field），
  // Merge 网关是 `thinking`（另带 thinking_signature，我们不回传签名所以不取）。先认前者，回退后者。
  const reasoning = m.reasoning_content || m.thinking;
  if (reasoning) content.push({ type: 'thinking', thinking: String(reasoning), signature: '' });
  if (m.content) content.push({ type: 'text', text: String(m.content) });
  if (m.refusal) content.push({ type: 'text', text: String(m.refusal) });
  for (const c of m.tool_calls || []) {
    content.push({ type: 'tool_use', id: c.id || `call_${content.length}`, name: c.function?.name || '', input: parseArgs(c.function?.arguments) });
  }
  const hasTools = (m.tool_calls || []).length > 0;
  const hasVisible = hasTools || Boolean(m.content) || Boolean(m.refusal);
  if (isAlienFinish(choice.finish_reason) && !hasVisible) {
    console.warn(`[ingress/openai-chat] upstream finish_reason='${choice.finish_reason}' with no visible output — failing the turn (non-stream)`);
    return null;
  }
  if (!hasVisible) console.warn(`[ingress/openai-chat] finish_reason='${choice.finish_reason}' 收尾但零可见输出（thinking-only，非流式）—— CLI 会补一轮催促`);
  const stop_reason = hasTools ? 'tool_use' : (STOP_MAP[choice.finish_reason] || 'end_turn');
  return {
    id: json?.id || `msg_${Date.now()}`,
    type: 'message', role: 'assistant',
    model: json?.model || '',
    content, stop_reason, stop_sequence: null,
    usage: usageFromOpenAI(json?.usage),
  };
}

/** 上游错误体 → Anthropic 错误体（CLI 会把 message 原样显示） */
export function toAnthropicError(status, bodyText) {
  let message = bodyText;
  try { const j = JSON.parse(bodyText); message = j?.error?.message || j?.message || bodyText; } catch { /* 非 JSON */ }
  const type = status === 401 || status === 403 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error'
      : status >= 500 ? 'api_error' : 'invalid_request_error';
  return { type: 'error', error: { type, message: String(message).slice(0, 2000) } };
}

/**
 * 非流式响应的「半截」判定（流式那份住在 OpenAIToAnthropicSSE.truncated；两边同一张判据 truncationReason）。
 * @returns {string|null} 原因串，null = 不是半截
 */
export function truncationOfChatResponse(json) {
  const choice = json?.choices?.[0];
  if (!choice) return null;
  const m = choice.message || {};
  return truncationReason({
    finish: choice.finish_reason,
    sawText: Boolean(m.content) || Boolean(m.refusal),
    sawToolCall: (m.tool_calls || []).length > 0,
  });
}

/**
 * 流式：OpenAI SSE chunk → Anthropic SSE 事件。Transform，直接 pipe。
 * 状态机：当前打开的块（thinking/text/tool_use 之一）+ tool_calls 按 index 映射到块号。
 */
export class OpenAIToAnthropicSSE extends Transform {
  constructor({ model = '', label = '上游' } = {}) {
    super();
    this.model = model;
    this.label = label;        // 上游的人话名字（错误文案用；CLI 会把 message 原样显示给用户）
    this.buf = '';
    this.started = false;
    this.done = false;
    this.blockIndex = -1;      // 最后分配的块号
    this.open = null;          // { kind: 'thinking'|'text'|'tool', index }
    this.toolBlocks = new Map();   // openai tool_call index → block index
    this.finish = null;
    this.usage = null;
    this.id = null;
    this.sawToolCall = false;
    this.sawText = false;      // 有过可见正文（区分"只想没说"的早断流）
    this.failReason = null;    // 本次以 error 事件收场的原因（forward 层据此记会话失败计数；null = 正常收尾）
    this.truncated = null;     // 本次「半截」收场的原因（见 truncationReason；forward 层据此报给 session-loop 续接）
    this.cost = null;          // 上游报的本次费用（美元，/zen/go 在 [DONE] 后补顶层 cost、Merge 网关放 usage.cost；null = 上游没报）
    this.doneSeen = false;     // 见过 [DONE]：之后只收 cost，收尾等 _flush
    this.attempts = 1;         // 这条 SSE 一共打了几发上游（就地重发会 ++）
    this.attemptUsage = null;  // 这一发的 usage
    this.attemptCost = null;   // 这一发的 cost
    // ⭐ 一份数两个读者，口径不同，别混（[[feedback-single-source-of-truth]]）：
    //   this.usage      = **最后一发**的 usage → 进 message_delta 发给 CLI。CLI 拿它算"我的上下文多大"，
    //                     累加会让一次重发把 input 翻倍，长会话里提前触发压缩。
    //   this.usageTotal = **所有发**的累计 → 进 onBilling。记账问的是"真烧了多少"，失败那发也烧了。
    this.usageTotal = null;
    this.sawStreamError = false;   // 流中途发过 error 事件：这条流已经死了，不许再重发也不许再收尾
  }
  _emit(event, data) { this.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  _ensureStart(chunk) {
    if (this.started) return;
    this.started = true;
    this.id = chunk?.id || `msg_${Date.now()}`;
    if (chunk?.model) this.model = chunk.model;
    this._emit('message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  _closeOpen() {
    if (!this.open) return;
    this._emit('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
  }
  _openBlock(kind, block) {
    this._closeOpen();
    this.blockIndex += 1;
    this.open = { kind, index: this.blockIndex };
    this._emit('content_block_start', { type: 'content_block_start', index: this.blockIndex, content_block: block });
    return this.blockIndex;
  }
  _handleChunk(chunk) {
    this._ensureStart(chunk);
    if (chunk.usage) this.attemptUsage = chunk.usage;
    const chunkCost = upstreamCostOf(chunk);   // 顶层 cost（Zen）或 usage.cost（Merge 网关）
    if (chunkCost != null) this.attemptCost = chunkCost;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};
    const reasoningDelta = d.reasoning_content || d.thinking;   // 同上：Merge 网关的增量字段叫 thinking
    if (reasoningDelta) {
      if (this.open?.kind !== 'thinking') this._openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
      this._emit('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'thinking_delta', thinking: String(reasoningDelta) } });
    }
    // content 与 refusal 都是"可见正文"，进同一个 text 块（拒答也是模型说的话，原样吐给用户）
    for (const piece of [d.content, d.refusal]) {
      if (!piece) continue;
      this.sawText = true;
      if (this.open?.kind !== 'text') this._openBlock('text', { type: 'text', text: '' });
      this._emit('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'text_delta', text: String(piece) } });
    }
    for (const tc of d.tool_calls || []) {
      // 按 index 分块；上游不带 index 时：带 id 的是新调用，否则续上一个
      const key = tc.index ?? (tc.id ? `id:${tc.id}` : this.lastToolKey);
      this.lastToolKey = key;
      this.sawToolCall = true;
      if (!this.toolBlocks.has(key)) {
        const idx = this._openBlock('tool', { type: 'tool_use', id: tc.id || `call_${key}`, name: tc.function?.name || '', input: {} });
        this.toolBlocks.set(key, idx);
      } else if (this.open?.kind !== 'tool' || this.open.index !== this.toolBlocks.get(key)) {
        // 上游交错回到旧的 tool_call（少见）：Anthropic 块一旦 stop 不能再开，只能并进当前块号
        this._closeOpen();
        this.open = { kind: 'tool', index: this.toolBlocks.get(key) };
      }
      const args = tc.function?.arguments;
      if (args) this._emit('content_block_delta', { type: 'content_block_delta', index: this.toolBlocks.get(key), delta: { type: 'input_json_delta', partial_json: String(args) } });
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
  }
  /**
   * 一次上游往返结束（流关了/断了）。**只结账 + 给判决，不发收尾事件** —— 因为判决可能是
   * "这一发白跑了，再打一次"，那时这条 SSE 还要继续用（forward 层的就地重发，见该文件）。
   * @returns {{ kind: 'complete'|'truncated'|'empty', reason?: string }}
   */
  attemptEnd() {
    this._foldAttemptTotals();
    this._closeOpen();          // 失败那一发开着的 thinking 块也要闭合，否则块永远悬着
    return this.verdict();
  }

  /**
   * 这一发算什么：
   *   empty     —— **零可见输出且收尾原因不可信**（没 finish / 私货 finish / 一个块都没开）。
   *                这是"白跑一发"，可以就地重发（跟 OpenCode 对 unknown finish 的做法一个意思）。
   *   truncated —— 说了一半被掐（判据见 truncationReason），照旧 end_turn 交付 + 标记续接。
   *   complete  —— 正常收尾。⭐ 已知 finish（stop/length）+ 零可见输出**不算 empty**：
   *                那是上游好好地告诉你"我就没话说"，OpenCode 同样直接结束不重试。
   */
  verdict() {
    // 已经往流里发过 error 事件：这条流按协议就结束了（CLI 实测收到流中 error 会 0.2 秒静默重发，
    // 人早走了）。既不能重发上游（纯烧钱），也不该再补 message_stop（error 之后再接内容块是非法的）。
    if (this.sawStreamError) return { kind: 'errored', reason: 'upstream sent an error mid-stream' };
    if (!this.started || (this.blockIndex < 0 && !this.finish)) {
      return { kind: 'empty', reason: 'empty response' };
    }
    const zeroVisible = !this.sawText && !this.sawToolCall;
    if (zeroVisible && !this.finish) return { kind: 'empty', reason: 'stream ended before any visible output' };
    if (zeroVisible && isAlienFinish(this.finish)) return { kind: 'empty', reason: `finish_reason='${this.finish}' with no visible output` };
    const truncated = truncationReason({ finish: this.finish, sawText: this.sawText, sawToolCall: this.sawToolCall, doneSeen: this.doneSeen });
    if (truncated) return { kind: 'truncated', reason: truncated };
    return { kind: 'complete' };
  }

  /** 整条响应收尾：发 Anthropic 的收场事件（或 error 事件）。调一次就封口。 */
  finalize(v = this.verdict()) {
    if (this.done) return;
    this.done = true;
    if (v.kind === 'errored') {   // error 事件已经发过了（块也已闭合），不再补任何事件
      this.failReason = this.failReason || v.reason;
      return;
    }
    if (v.kind === 'empty') {
      // 零可见输出且收尾不可信 —— forward 层已经就地重发过（额度用完了才走到这），
      // 别包装成"成功的空消息"让 CLI 当正常结束（那会触发它"你上一轮没有可见输出"的催促循环）
      this._ensureStart(null);
      this.failReason = v.reason;
      const msg = v.reason === 'empty response'
        ? `${this.label}返回了空响应，一个字都没有 —— 上游问题，已自动重发仍失败；稍后再发，或换个模型（upstream returned an empty response）`
        : v.reason.startsWith('finish_reason=')
          ? `${this.label}以 ${this.finish} 结束了这次请求，没有输出任何正文 —— 上游自己的链路出错，已自动重发仍失败；稍后再发，或换个模型（upstream ended with ${v.reason}）`
          : `${this.label}在模型还在思考、还没输出正文时就结束了响应 —— 上游问题，已自动重发仍失败；稍后再发，或换个模型/思考档（upstream stream ended before any visible output）`;
      console.warn(`[ingress/openai-chat] 零可见输出收场（${v.reason}）—— 重发额度已用完，这一轮判失败`);
      this._emit('error', { type: 'error', error: { type: 'api_error', message: msg } });
      return;
    }
    if (v.kind === 'truncated') {
      this.truncated = v.reason;
      console.warn(`[ingress/openai-chat] 半截收场（${v.reason}）—— 按 end_turn 交付，标记待续接`);
    } else if (isAlienFinish(this.finish)) {
      console.warn(`[ingress/openai-chat] 未知 finish_reason='${this.finish}'（有可见输出）；按 end_turn 收尾`);
    } else if (this.finish && !this.sawText && !this.sawToolCall) {
      // 已知 finish 但零可见块：上游明说自己收完了，不重发（跟 OpenCode 一致）。CLI 会补一轮催促
      console.warn(`[ingress/openai-chat] finish_reason='${this.finish}' 收尾但零可见输出（thinking-only）—— CLI 会补一轮催促`);
    }
    this._closeOpen();
    const stop_reason = this.sawToolCall ? 'tool_use' : (STOP_MAP[this.finish] || 'end_turn');
    this._emit('message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: usageFromOpenAI(this.usage) });
    this._emit('message_stop', { type: 'message_stop' });
  }

  /**
   * 就地失败收尾：发一条 error 事件就封口（重发那几发拿到 4xx/5xx 时用）。
   * ⚠️ 必须走它而不是"手写 _emit + end"：`done` 要在这里置上，否则 `_flush` 会再判决一次、
   * 补第二条 error，还会把 failReason 从真因（限流/鉴权）盖成"零可见输出"。
   */
  failWith(message, reason) {
    if (this.done) return;
    this.done = true;
    this.failReason = reason || 'upstream error';
    this._ensureStart(null);
    this._closeOpen();
    this._emit('error', { type: 'error', error: { type: 'api_error', message: String(message).slice(0, 2000) } });
  }

  /**
   * 开始新一发上游往返（就地重发时调）。**只重置"这一发"的状态**：
   * 块号 / 已发出的块 / 见过正文没 / 累计 usage 与 cost 全部保留 —— 它们属于这条 SSE 而不是某一发。
   */
  beginAttempt() {
    this.buf = '';
    this.finish = null;
    this.doneSeen = false;
    this.attemptUsage = null;
    this.toolBlocks = new Map();   // 新一发的 tool_call index 从 0 重来，别跟上一发的块号串了
    this.lastToolKey = undefined;
    this.attempts += 1;
  }

  /** 把这一发的 usage/cost 折进整条响应的累计（失败那一发也烧了上游的 token，账要算它） */
  _foldAttemptTotals() {
    const u = this.attemptUsage;
    if (u) {
      this.usage = u;                       // 给 CLI 的：最后一发的真实上下文大小
      const t = this.usageTotal || { prompt_tokens: 0, completion_tokens: 0 };
      this.usageTotal = {
        prompt_tokens: (t.prompt_tokens || 0) + (u.prompt_tokens || 0),
        completion_tokens: (t.completion_tokens || 0) + (u.completion_tokens || 0),
        prompt_tokens_details: { cached_tokens: (t.prompt_tokens_details?.cached_tokens || 0) + (u.prompt_tokens_details?.cached_tokens || 0) },
        completion_tokens_details: { reasoning_tokens: (t.completion_tokens_details?.reasoning_tokens || 0) + (u.completion_tokens_details?.reasoning_tokens || 0) },
      };
      this.attemptUsage = null;
    }
    if (this.attemptCost != null) {
      this.cost = (this.cost || 0) + this.attemptCost;
      this.attemptCost = null;
    }
  }

  _transform(chunk, _enc, cb) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      // [DONE] 不立刻收尾：Zen（/zen/go 入口）在 [DONE] **之后**还补一条 {"choices":[],"cost":"0.00123"}，
      // 那是上游报的真实费用（记账要它）。[DONE] 后只认 cost，别的都忽略；真正收尾在 _flush（上游关流）
      if (payload === '[DONE]') { this.doneSeen = true; continue; }
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (this.doneSeen || this.done) { const c = upstreamCostOf(j); if (c != null) this.attemptCost = c; continue; }
      if (j?.error) {   // 流中途的错误体：转成 Anthropic error 事件
        this._ensureStart(j);
        this._closeOpen();          // 先把开着的块闭合再发 error（顺序反了会出现 error 后面还跟 content_block_stop）
        this.sawStreamError = true;
        this._emit('error', { type: 'error', error: { type: 'api_error', message: String(j.error.message || j.error) } });
        continue;
      }
      try { this._handleChunk(j); } catch (err) { console.warn('[ingress/openai-chat] chunk handling failed:', err.message); }
    }
    cb();
  }
  _flush(cb) {
    // 单发场景（没人调 attemptEnd 手动收尾）：走同一条判决 → 收尾的路，行为与从前一致
    if (!this.done) this.finalize(this.attemptEnd());
    cb();
  }
}
