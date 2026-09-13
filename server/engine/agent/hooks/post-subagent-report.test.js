// 子代理报告丢失兜底（2026-08-18）。这条闸防的是"整轮白烧"，所以测试要真复现
// 那个场景：跑了十几轮工具调用、烧了几万 token，回来的摘要只有一句开场白。
import { describe, it, expect } from 'vitest';
import { recordTaskNotification, makePostToolUseSubagentReportRecovery } from './post-subagent-report.js';

const handler = makePostToolUseSubagentReportRecovery();
const ctxOf = (id) => ({ tool_use_id: id });

describe('子代理报告丢失兜底', () => {
  it('⭐ 干了活但只回一句开场白 → 递转录路径，明说别重派', async () => {
    recordTaskNotification({
      tool_use_id: 'tu_1', status: 'completed', output_file: '/tmp/agent-abc.jsonl',
      summary: '开始系统研究这四组事实。先从 A 类开始——这需要真正看这些产品。',
      usage: { total_tokens: 59292, tool_uses: 16, duration_ms: 110000 },
    });
    const out = await handler(ctxOf('tu_1'));
    const text = out.hookSpecificOutput.additionalContext;
    expect(text).toMatch(/确实干了活/);
    expect(text).toMatch(/agent-abc\.jsonl/);
    expect(text).toMatch(/不要整轮重派/);
    expect(text).toMatch(/16 次工具调用/);
  });

  it('返回完全为空（"returned no output"那种）也要兜住', async () => {
    recordTaskNotification({
      tool_use_id: 'tu_2', status: 'completed', output_file: '/tmp/agent-def.jsonl',
      summary: '', usage: { total_tokens: 31228, tool_uses: 17, duration_ms: 63000 },
    });
    const out = await handler(ctxOf('tu_2'));
    expect(out.hookSpecificOutput.additionalContext).toMatch(/agent-def\.jsonl/);
  });

  it('报告正常回来了 → 一个字都不加（噪音会训练 agent 忽略提示）', async () => {
    recordTaskNotification({
      tool_use_id: 'tu_3', status: 'completed', output_file: '/tmp/x.jsonl',
      summary: '报告：'.padEnd(400, '内容'),
      usage: { total_tokens: 20000, tool_uses: 6, duration_ms: 40000 },
    });
    expect(await handler(ctxOf('tu_3'))).toEqual({});
  });

  it('轮次少、活也少的空返回 → 提示但不说"确实干了活"（那会是假断言）', async () => {
    recordTaskNotification({
      tool_use_id: 'tu_4', status: 'failed', output_file: '/tmp/y.jsonl',
      summary: '', usage: { total_tokens: 300, tool_uses: 1, duration_ms: 900 },
    });
    const text = (await handler(ctxOf('tu_4'))).hookSpecificOutput.additionalContext;
    expect(text).not.toMatch(/确实干了活/);
    expect(text).toMatch(/y\.jsonl/);
  });

  it('同一个 tool_use_id 只提示一次', async () => {
    recordTaskNotification({ tool_use_id: 'tu_5', status: 'completed', summary: '', output_file: '/tmp/z.jsonl' });
    expect((await handler(ctxOf('tu_5'))).hookSpecificOutput).toBeTruthy();
    expect(await handler(ctxOf('tu_5'))).toEqual({});
  });

  it('没记过这个 tool_use_id（不是子代理调用）→ 不插手', async () => {
    expect(await handler(ctxOf('tu_unknown'))).toEqual({});
    expect(await handler({})).toEqual({});
  });

  it('没有转录路径时不许假装有 —— 改说拆小重派', async () => {
    recordTaskNotification({ tool_use_id: 'tu_6', status: 'stopped', summary: '', usage: { tool_uses: 12 } });
    const text = (await handler(ctxOf('tu_6'))).hookSpecificOutput.additionalContext;
    expect(text).toMatch(/没有可用的转录路径/);
    expect(text).toMatch(/拆小/);
  });
});

// ⚠️ 上面那些测试全是**直接调 recordTaskNotification**，压根没覆盖"agent-shared
// 到底有没有调它"这一环 —— 我把那行注释掉之后测试照样全绿。这个仓库栽过同样的
// 病（08-14 空壳钩子灭门案、turn.js 那条"从来没生效过"的 race 修复），所以这里
// 单独钉住接线：走真实的 handleSDKMessage 派发一条 task_notification。
describe('接线（不是只测函数本身）', () => {
  it('handleSDKMessage 收到 task_notification 时必须记一笔', async () => {
    const { handleSDKMessage } = await import('../agent-shared.js');
    const ctx = {
      emit() {}, absorbSubagentUsage() {},
      workspace: { root: () => null },      // 让便签那条路自己 return，不碰文件系统
      runId: 'r_test',
    };
    handleSDKMessage(ctx, {
      type: 'system', subtype: 'task_notification',
      task_id: 't_wire', tool_use_id: 'tu_wire', status: 'completed',
      summary: '', output_file: '/tmp/wire.jsonl',
      usage: { total_tokens: 40000, tool_uses: 14, duration_ms: 90000 },
    });
    const out = await makePostToolUseSubagentReportRecovery()({ tool_use_id: 'tu_wire' });
    expect(out.hookSpecificOutput?.additionalContext).toMatch(/wire\.jsonl/);
  });
});

describe('09-13 服务端直接取回子代理最后几段回复（getSubagentMessages）', () => {
  const note = (id, extra = {}) => recordTaskNotification({
    tool_use_id: id, task_id: `agent_${id}`, status: 'completed', output_file: `/tmp/tasks/agent_${id}.output`,
    summary: '开始研究。', usage: { total_tokens: 40000, tool_uses: 12 }, ...extra,
  });
  const input = (id) => ({ tool_use_id: id, session_id: 'sess-1', cwd: '/work/proj' });

  it('⭐ 取回了 → 正文直接拼进 additionalContext，不再让主 agent 自己去读转录', async () => {
    const calls = [];
    const h = makePostToolUseSubagentReportRecovery({ readTail: async (a) => { calls.push(a); return '结论：A 组三款都支持离线导出。'.padEnd(300, '。'); } });
    note('r1');
    const text = (await h(input('r1'))).hookSpecificOutput.additionalContext;
    expect(calls[0]).toEqual({ sessionId: 'sess-1', agentId: 'agent_r1', dir: '/work/proj' });
    expect(text).toMatch(/<subagent_last_replies>[\s\S]*A 组三款都支持离线导出[\s\S]*<\/subagent_last_replies>/);
    expect(text).not.toMatch(/Read 它取回结论/);
  });

  it('读失败 → 退回老路（递转录路径）', async () => {
    const warn = console.warn; console.warn = () => {};
    const h = makePostToolUseSubagentReportRecovery({ readTail: async () => { throw new Error('ENOENT'); } });
    note('r2');
    const text = (await h(input('r2'))).hookSpecificOutput.additionalContext;
    console.warn = warn;
    expect(text).toMatch(/agent_r2\.output/);
    expect(text).toMatch(/Read 它取回结论/);
  });

  it('子代理自己也没写出比摘要更多的字 → 退回老路，不贴一段空标签', async () => {
    const h = makePostToolUseSubagentReportRecovery({ readTail: async () => '开始研究。' });
    note('r3');
    const text = (await h(input('r3'))).hookSpecificOutput.additionalContext;
    expect(text).not.toMatch(/subagent_last_replies/);
    expect(text).toMatch(/Read 它取回结论/);
  });

  it('没有 task_id（旧 SDK / 非子代理任务）→ 不尝试读，老路', async () => {
    let called = false;
    const h = makePostToolUseSubagentReportRecovery({ readTail: async () => { called = true; return 'x'.repeat(500); } });
    note('r4', { task_id: undefined });
    await h(input('r4'));
    expect(called).toBe(false);
  });
});

describe('lastAssistantTexts', () => {
  const a = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  it('按原顺序取最后几段 assistant 文本，跳过 user 与纯工具调用', async () => {
    const { lastAssistantTexts } = await import('./post-subagent-report.js');
    const msgs = [a('第一段'), { type: 'user', message: { content: 'tool result' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }, a('第二段')];
    expect(lastAssistantTexts(msgs)).toBe('第一段\n\n第二段');
  });
  it('超长时保留结尾（结论通常在最后）并截到上限', async () => {
    const { lastAssistantTexts } = await import('./post-subagent-report.js');
    const out = lastAssistantTexts([a('开头'.repeat(100)), a(`${'x'.repeat(50)}结论在这`)], 20);
    expect(out.endsWith('结论在这')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
  });
});
