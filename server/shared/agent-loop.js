/**
 * 共享 Agent 循环（流式 + tool use）
 *
 * 来源：从 dev/server/bot/agent-loop.js 复制（仅改环境变量名）
 *
 * 这是真正通用的 agent 循环，行为无业务耦合：
 *   - SDK 流式调用 + 思考链增量回调
 *   - tool_use 循环（最多 maxRounds 轮）
 *   - 每轮 assistant 完整 content 入 messages 历史（保留 thinking blocks，
 *     满足 interleaved thinking 的顺序约束）
 *   - max_tokens 截断和轮数耗尽的优雅退化
 *
 * 调用方通过回调 hook 进度事件、动态构建 system prompt。
 *
 * Nodesign 用法：engine 模块的 skill runner、edit 模块的协作 agent 都通过此循环驱动。
 */

import { client, DEFAULT_MODEL, INTERLEAVED_THINKING_HEADERS } from './anthropic-client.js';

const ERROR_TEXT = '抱歉，我暂时无法处理请求，请稍后再试。';

/**
 * 单工具执行超时（毫秒）。超过则中止该工具并把 timeout error 喂给 LLM。
 *
 * deskskill-engine 跑长 reasoning 时，Round 1/2 单轮可能 1-3 分钟，
 * 但工具调用本身（write_file / preview_screenshot）应该秒级完成。
 * 默认 60s 给 preview / playwright 预留余量。
 */
const TOOL_TIMEOUT_MS = Number(process.env.ENGINE_TOOL_TIMEOUT_MS) || 60_000;

/** 从 content 数组提取所有 text blocks 拼成字符串 */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/**
 * executeTool 加 timeout 保护 + AbortController
 * - 超时不仅 reject wait，还会 abort 底层 fetch 真正释放资源
 * - 若 executeTool 不接受 signal（历史调用方），fallback 退化为单纯 Promise.race
 * - 超时抛 Error（code='TOOL_TIMEOUT'），agent-loop 外层 classify 为 timeout+retryable
 */
function runToolWithTimeout(executeTool, name, input, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`工具 ${name} 执行超过 ${timeoutMs}ms 未返回`);
      err.code = 'TOOL_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => executeTool(name, input, { signal: controller.signal })),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

/**
 * 跑一次 agent 循环
 *
 * @param {object} opts
 * @param {string} [opts.model] - 模型名，默认 DEFAULT_MODEL
 * @param {number} opts.maxTokens
 * @param {number} opts.maxRounds - tool use 最大轮数
 * @param {Function} opts.buildSystem - (round, ctx) => string | object[]，
 *                                       支持每轮重建（注入 toolLog 等）
 * @param {Array} opts.initialMessages - 初始 messages 历史（不含本轮 user）
 * @param {Array} opts.tools - tool definitions（可空）
 * @param {object} [opts.thinking] - 如 { type: 'enabled', budget_tokens: 4000 }
 * @param {boolean} [opts.interleaved=false] - 是否开启交错思考
 * @param {Function} opts.executeTool - (name, input, { signal }) => Promise<any>
 *
 * @param {Function} [opts.onTextChunk]    - (delta, round) => void
 * @param {Function} [opts.onThinkingChunk]- (delta, round) => void
 * @param {Function} [opts.onRoundStart]   - (round) => void
 * @param {Function} [opts.onToolStart]    - (toolSteps) => Promise|void
 * @param {Function} [opts.onToolDone]     - (toolSteps) => Promise|void
 *
 * @returns {Promise<{ text, toolSteps, toolSummaries, truncated, exhausted }>}
 */
export async function runAgentLoop(opts) {
  const {
    model = DEFAULT_MODEL,
    maxTokens,
    maxRounds,
    buildSystem,
    initialMessages,
    tools = [],
    thinking,
    interleaved = false,
    executeTool,
    onTextChunk,
    onThinkingChunk,
    onRoundStart,
    onToolStart,
    onToolDone,
  } = opts;

  const messages = [...initialMessages];
  const toolSteps = [];
  const toolSummaries = [];

  for (let round = 0; round < maxRounds; round++) {
    onRoundStart?.(round);

    const body = {
      model,
      max_tokens: maxTokens,
      system: buildSystem(round, { messages, toolSummaries }),
      messages,
    };
    if (tools.length > 0) body.tools = tools;
    if (thinking) body.thinking = thinking;

    const requestOpts = interleaved ? { headers: INTERLEAVED_THINKING_HEADERS } : undefined;

    const stream = client.messages.stream(body, requestOpts);

    // 诊断计数器（每轮独立）
    let textCount = 0, thinkingCount = 0;

    if (onTextChunk) {
      stream.on('text', (delta) => {
        textCount++;
        onTextChunk(delta, round);
      });
    }
    if (onThinkingChunk) {
      stream.on('streamEvent', (evt) => {
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          thinkingCount++;
          onThinkingChunk(evt.delta.thinking, round);
        }
      });
    }

    let final;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      console.error('[AgentLoop] stream 失败:', err.message);
      throw err;
    }

    const blockTypes = final.content.map(b => b.type).join(',');
    const cacheRead = final.usage?.cache_read_input_tokens || 0;
    const cacheWrite = final.usage?.cache_creation_input_tokens || 0;
    console.log(
      `[AgentLoop] round=${round} blocks=[${blockTypes}] ` +
      `chunks(text=${textCount}, thinking=${thinkingCount}) ` +
      `tokens(in=${final.usage?.input_tokens}, out=${final.usage?.output_tokens}, ` +
      `cacheR=${cacheRead}, cacheW=${cacheWrite}) ` +
      `stop=${final.stop_reason} interleaved=${interleaved}`
    );

    // 完整 content 入历史（保留 thinking + tool_use 顺序，满足 interleaved 约束）
    messages.push({ role: 'assistant', content: final.content });

    const hasToolUse = final.content.some(b => b.type === 'tool_use');

    // ── max_tokens 截断 ──
    if (final.stop_reason === 'max_tokens') {
      const partial = extractText(final.content);
      const text = partial ? partial + '\n\n_(回复过长被截断)_' : ERROR_TEXT;
      return { text, toolSteps, toolSummaries, truncated: true, final };
    }

    // ── 终止：模型不再调工具 ──
    if (final.stop_reason === 'end_turn' || !hasToolUse) {
      const text = extractText(final.content) || ERROR_TEXT;
      return { text, toolSteps, toolSummaries, final };
    }

    // ── 执行工具 ──
    const toolUseBlocks = final.content.filter(b => b.type === 'tool_use');
    // 用 block.id 唯一标识每个 step；name 不唯一（同名工具多次调用时会碰撞）
    const newSteps = toolUseBlocks.map(b => ({ name: b.name, blockId: b.id, done: false }));
    toolSteps.push(...newSteps);

    if (onToolStart) await onToolStart(toolSteps);

    const toolResults = [];
    const errorInfos = []; // 本轮每次调用的 error 信息（success 位 null）
    for (const block of toolUseBlocks) {
      let result;
      let isError = false;
      let errorInfo = null;

      try {
        const out = await runToolWithTimeout(executeTool, block.name, block.input, TOOL_TIMEOUT_MS);
        // 识别结构化 error shape：{ ok: false, error: { category, message, retryable } }
        if (out && out.ok === false && out.error) {
          isError = true;
          errorInfo = out.error;
        }
        result = JSON.stringify(out, null, 2);
      } catch (err) {
        // 工具未吞掉的异常（如 timeout、或极端底层错）→ 构造同 shape
        const category = err?.code === 'TOOL_TIMEOUT' ? 'timeout' : 'unknown';
        const retryable = category === 'timeout';
        errorInfo = { category, message: err?.message || String(err), retryable, tool: block.name };
        console.error(`[AgentLoop] 工具 ${block.name} 异常 (${category}):`, err?.message);
        result = JSON.stringify({ ok: false, error: errorInfo }, null, 2);
        isError = true;
      }

      const tr = {
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      };
      if (isError) tr.is_error = true;
      toolResults.push(tr);
      errorInfos.push(errorInfo);

      // 工具调用摘要（给 toolLog 用，失败时带 category）
      const inputBrief = JSON.stringify(block.input).slice(0, 80);
      const marker = isError ? `失败(${errorInfo?.category || 'error'})` : '成功';
      toolSummaries.push(`${block.name}(${inputBrief}) → ${marker}`);

      // 用 block.id 精确定位（同名工具多次调用也能正确标记）
      const step = toolSteps.find(s => s.blockId === block.id);
      if (step) {
        step.done = true;
        if (errorInfo) step.error = errorInfo;
      }
    }

    if (onToolDone) await onToolDone(toolSteps);

    messages.push({ role: 'user', content: toolResults });

    // ── 全失败兜底：本轮所有工具都挂且均不可重试 → 提前终止 ──
    const failed = errorInfos.filter(Boolean);
    if (failed.length === toolUseBlocks.length && failed.length > 0) {
      const anyRetryable = failed.some(e => e.retryable);
      if (!anyRetryable) {
        console.error(`[AgentLoop] round=${round} 本轮 ${failed.length} 个工具全部失败且均不可重试，提前终止`);
        const summary = toolSummaries.slice(-failed.length).join('\n');
        return {
          text: `${ERROR_TEXT}\n\n本轮尝试：\n${summary}`,
          toolSteps,
          toolSummaries,
          allFailed: true,
          exhausted: true,
        };
      }
    }
  }

  // 轮数耗尽
  const tail = toolSummaries.slice(-3).join('\n');
  const hint = tail ? `\n\n最近尝试：\n${tail}` : '';
  return {
    text: `查询过程过于复杂，请尝试更简单的问题。${hint}`,
    toolSteps,
    toolSummaries,
    exhausted: true,
  };
}

export { ERROR_TEXT };
