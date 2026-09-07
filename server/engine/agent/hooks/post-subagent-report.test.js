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
