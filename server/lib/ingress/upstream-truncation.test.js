import { describe, it, expect } from 'vitest';
import { UpstreamTruncation } from './upstream-truncation.js';
import { truncationReason, truncationOfChatResponse, OpenAIToAnthropicSSE } from './openai-chat.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWireModel } from '../../engine/agent/model-context.js';
import { MAX_RETRY_BUDGET_MS } from '../../runtime/local-config.js';

describe('truncationReason —— 什么算「说到一半被掐」', () => {
  it('有正文 + 没有 finish_reason = 半截', () => {
    expect(truncationReason({ finish: null, sawText: true, sawToolCall: false })).toBe('no finish_reason');
  });
  it('有正文 + 私货 finish（network_error）= 半截', () => {
    expect(truncationReason({ finish: 'network_error', sawText: true, sawToolCall: false }))
      .toBe("finish_reason='network_error'");
  });
  it('⭐ 发了 [DONE] 只是末块没 finish_reason = 收完了，不算半截（否则换一家这脾气的上游就每轮平白续接到封顶）', () => {
    expect(truncationReason({ finish: null, sawText: true, sawToolCall: false, doneSeen: true })).toBeNull();
  });
  it('私货 finish 即便见过 [DONE] 也算半截（那是上游自己说链路出错了）', () => {
    expect(truncationReason({ finish: 'network_error', sawText: true, sawToolCall: false, doneSeen: true }))
      .toBe("finish_reason='network_error'");
  });
  it('有正文 + 正常收尾 = 不是半截', () => {
    expect(truncationReason({ finish: 'stop', sawText: true, sawToolCall: false })).toBeNull();
    expect(truncationReason({ finish: 'length', sawText: true, sawToolCall: false })).toBeNull();
  });
  it('零正文（thinking-only 早断流）不走续接 —— 那条已经发 error 事件让 CLI 自己重试', () => {
    expect(truncationReason({ finish: null, sawText: false, sawToolCall: false })).toBeNull();
    expect(truncationReason({ finish: 'network_error', sawText: false, sawToolCall: false })).toBeNull();
  });
  it('⛔ 出过 tool_call 的半截不算 —— CLI 自己会治（坏 JSON → InputValidationError → 模型重来），叠加续接反而把回合拖进 max_turns', () => {
    expect(truncationReason({ finish: null, sawText: true, sawToolCall: true })).toBeNull();
    expect(truncationReason({ finish: 'network_error', sawText: true, sawToolCall: true })).toBeNull();
  });
});

describe('truncationOfChatResponse —— 非流式与流式同一张判据', () => {
  const wrap = (message, finish) => ({ choices: [{ message, finish_reason: finish }] });
  it('正文 + 无 finish = 半截', () => {
    expect(truncationOfChatResponse(wrap({ content: '说到一半' }, null))).toBe('no finish_reason');
  });
  it('正文 + stop = 完整', () => {
    expect(truncationOfChatResponse(wrap({ content: '说完了' }, 'stop'))).toBeNull();
  });
  it('带 tool_calls 的不算', () => {
    expect(truncationOfChatResponse(wrap({ content: 'x', tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{}' } }] }, null))).toBeNull();
  });
  it('refusal 也算正文（转换层把它当文本读）', () => {
    expect(truncationOfChatResponse(wrap({ refusal: '不行' }, null))).toBe('no finish_reason');
  });
  it('没有 choices → null（那条走的是"空响应"分支，不是半截）', () => {
    expect(truncationOfChatResponse({ choices: [] })).toBeNull();
    expect(truncationOfChatResponse(null)).toBeNull();
  });
});

describe('UpstreamTruncation —— 只记最近一次，取走即清', () => {
  it('记了能取到，取走就没了', () => {
    const t = new UpstreamTruncation();
    t.note('sid1', 'no finish_reason', { appModel: 'glm-5.3-flash-merge' });
    expect(t.take('sid1')).toMatchObject({ reason: 'no finish_reason', appModel: 'glm-5.3-flash-merge' });
    expect(t.take('sid1')).toBeNull();
  });
  it('后面一次收得完整就把标记清掉（一个回合里多次往返，只有收尾那次算数）', () => {
    const t = new UpstreamTruncation();
    t.note('sid1', 'no finish_reason');
    t.note('sid1', null);
    expect(t.take('sid1')).toBeNull();
  });
  it('会话之间互不干扰', () => {
    const t = new UpstreamTruncation();
    t.note('a', 'no finish_reason');
    expect(t.take('b')).toBeNull();
    expect(t.take('a')).not.toBeNull();
  });
  it('没 sid 不炸', () => {
    const t = new UpstreamTruncation();
    expect(() => t.note(null, 'x')).not.toThrow();
    expect(t.take(null)).toBeNull();
  });
});

// ── 就地重发（08-21 夜，跟 OpenCode 对齐）──
describe('OpenAIToAnthropicSSE.verdict —— 哪一发该原地重发', () => {
  const feed = (xf, lines) => { for (const l of lines) xf.write(`data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`); };
  const chunk = (delta, finish = null) => ({ id: 'c1', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });

  it('只想了没说就断 = empty（该重发）', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    feed(xf, [chunk({ reasoning_content: '想想…' })]);
    expect(xf.attemptEnd()).toMatchObject({ kind: 'empty', reason: 'stream ended before any visible output' });
  });

  it('一个 chunk 都没来 = empty（该重发）', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    expect(xf.attemptEnd()).toMatchObject({ kind: 'empty', reason: 'empty response' });
  });

  it('私货 finish + 零可见 = empty（该重发）', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    feed(xf, [chunk({ reasoning_content: '想想…' }), chunk({}, 'network_error')]);
    expect(xf.attemptEnd()).toMatchObject({ kind: 'empty' });
  });

  it('⛔ 已知 finish + 零可见输出**不重发** —— 上游明说它收完了（OpenCode 同样不重试）', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    feed(xf, [chunk({ reasoning_content: '想想…' }), chunk({}, 'stop')]);
    expect(xf.attemptEnd()).toMatchObject({ kind: 'complete' });
  });

  it('⛔ 说了一半被掐**不重发** —— 正文已经流给用户了，重发会重复（走 session-loop 续接）', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    feed(xf, [chunk({ content: '说到一半' })]);
    expect(xf.attemptEnd()).toMatchObject({ kind: 'truncated', reason: 'no finish_reason' });
  });

  it('正常收尾 = complete', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    feed(xf, [chunk({ content: '说完了' }), chunk({}, 'stop')]);
    expect(xf.attemptEnd()).toMatchObject({ kind: 'complete' });
  });

  it('跨发累计：失败那一发烧的 token 与 cost 也要算进账', () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    feed(xf, [{ ...chunk({ reasoning_content: '想' }), usage: { prompt_tokens: 100, completion_tokens: 20 }, cost: '0.01' }]);
    expect(xf.attemptEnd().kind).toBe('empty');
    xf.beginAttempt();
    feed(xf, [{ ...chunk({ content: '好' }), usage: { prompt_tokens: 100, completion_tokens: 30 }, cost: '0.02' }, chunk({}, 'stop')]);
    expect(xf.attemptEnd().kind).toBe('complete');
    // ⭐ 两个读者两个口径：给 CLI 的是最后一发（上下文多大），给记账的是累计（真烧了多少）
    expect(xf.usage.prompt_tokens).toBe(100);
    expect(xf.usageTotal.prompt_tokens).toBe(200);
    expect(xf.usageTotal.completion_tokens).toBe(50);
    expect(xf.cost).toBeCloseTo(0.03);
    expect(xf.attempts).toBe(2);
  });

  it('重发后块号接着往下排（同一条消息，不重开 message_start）', async () => {
    const xf = new OpenAIToAnthropicSSE({ label: '上游' });
    const out = [];
    xf.on('data', (d) => out.push(d.toString()));
    feed(xf, [chunk({ reasoning_content: '想' })]);
    xf.attemptEnd();
    xf.beginAttempt();
    feed(xf, [chunk({ content: '好' }), chunk({}, 'stop')]);
    xf.finalize(xf.attemptEnd());
    await new Promise((r) => { xf.end(); xf.on('end', r); xf.resume(); });
    const text = out.join('');
    expect(text.match(/event: message_start/g)).toHaveLength(1);
    expect(text.match(/event: message_stop/g)).toHaveLength(1);
    expect(text).toMatch(/"index":0[\s\S]*"index":1/);   // 思考块 0，重发后的正文块 1
  });
});

describe('就地重发额度按行配（08-21 深夜：这是模型体质问题，不是协议问题）', () => {
  // 08-26：唯一放宽过的两行（Ox 主行 / 深想行）随模型整族下架一起删了，今天**内置表里一条都没配**。
  // 这三条断言因此换了钉法 —— 钉的不再是"那两行的数对不对"，而是这个旋钮**没有腐烂成死代码**：
  // 字段仍从表通到 wire、读它的人还在读、任何人将来配上都不会撑破 CLI 的总超时。
  it('今天内置行一条都没放宽（走全局默认），字段仍**经 resolveWireModel 通到 forward**', () => {
    for (const id of ['glm-5.3-flash-merge', 'deepseek-v4-flash-vision', 'deepseek-v4-flash-helper', 'minimax-m3']) {
      const wire = resolveWireModel(id);
      expect(wire, `${id} 该在表里`).toBeTruthy();
      // null 而不是 undefined：resolveWireModel 显式产出这两个键，forward 才 Number.isFinite 得下去
      expect(wire.emptyRetries, `${id}`).toBeNull();
      expect(wire.retryBudgetMs, `${id}`).toBeNull();
      expect('emptyRetries' in wire && 'retryBudgetMs' in wire, `${id} 的键该在`).toBe(true);
    }
  });

  it('⛔ 旋钮不许烂成死代码：forward 仍按行取额度，行内没写才落全局默认', () => {
    const fwd = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'forward-openai-chat.js'), 'utf8');
    expect(fwd).toMatch(/Number\.isFinite\(wire\.emptyRetries\)\s*\?\s*wire\.emptyRetries\s*:\s*emptyRetryLimit\(\)/);
    expect(fwd).toMatch(/Number\.isFinite\(wire\.retryBudgetMs\)\s*\?\s*wire\.retryBudgetMs\s*:\s*retryBudgetMs\(\)/);
  });

  it('⛔ 任何预算 + 单发最长挂起都必须留在 CLI 流式请求的 600 秒总超时之内（实测单发最长挂 185 秒）', () => {
    const WORST_ATTEMPT_MS = 185_000;
    const CLI_REQUEST_TIMEOUT_MS = 600_000;   // SDK 客户端 timeout 默认值（binary 实查）
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../engine/agent/model-table.js'), 'utf8');
    // 内置行：今天是空的（08-26 起），将来谁配上就得过这道尺
    for (const m of src.matchAll(/retryBudgetMs:\s*([0-9_]+)/g)) {
      expect(Number(m[1].replace(/_/g, '')) + WORST_ATTEMPT_MS).toBeLessThan(CLI_REQUEST_TIMEOUT_MS);
    }
    // 外部插槽（本地分发版用户自己填）：内置行空了之后，**这道天花板才是今天真正在生效的那道**
    expect(MAX_RETRY_BUDGET_MS + WORST_ATTEMPT_MS).toBeLessThan(CLI_REQUEST_TIMEOUT_MS);
  });
});
