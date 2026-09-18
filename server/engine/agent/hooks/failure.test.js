// PostToolUseFailure 的恢复建议（2026-08-15 加沙盒偶发那条时补的测试）
import { describe, it, expect, vi } from 'vitest';
import { makePostToolUseFailureHandler, failureSummary } from './failure.js';

const ctx = { emit: vi.fn() };
const run = (tool_name, error) =>
  makePostToolUseFailureHandler({ ctx, projectId: 'p', sessionId: 's' })({ tool_name, error });

describe('沙盒启动偶发要点破', () => {
  it('⭐ apply-seccomp / unshare EINVAL → 明说"重跑一次"，别让 agent 推断成权限拦截', async () => {
    const out = await run('Bash', 'apply-seccomp: unshare(CLONE_NEWUSER): Invalid argument');
    const text = out.hookSpecificOutput.additionalContext;
    expect(text).toMatch(/原样再跑一次/);
    expect(text).toMatch(/不是权限拦截/);
  });
  it('普通 Bash 失败还是走老那套建议', async () => {
    const out = await run('Bash', 'cat: x: No such file or directory');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/命令本身错/);
  });
  it('用户中断不给建议', async () => {
    const h = makePostToolUseFailureHandler({ ctx, projectId: 'p', sessionId: 's' });
    expect(await h({ tool_name: 'Bash', error: 'x', is_interrupt: true })).toEqual({});
  });
});

describe('按错因分流（09-17）', () => {
  const zod = 'MCP error -32602: Input validation error: Invalid arguments for tool generate_image: [ { "expected": "array", "code": "invalid_type", "path": [ "referenceImages" ] } ]';
  it('⭐ 入参没过校验：说明没执行、别原样重发 —— 不能落进「先重试 1 次」', async () => {
    const text = (await run('mcp__nodesign__generate_image', zod)).hookSpecificOutput.additionalContext;
    expect(text).toMatch(/没有执行/);
    expect(text).toMatch(/原样重发会得到同样的错误/);
    expect(text).not.toMatch(/重试 1/);
    expect(text).not.toMatch(/去掉否定描述/);   // generate_image 的「400 = prompt 问题」那支不该接住它
  });
  it('batch 的入参校验失败也走这支（整批没跑，不是「前面几步已执行」）', async () => {
    const text = (await run('mcp__nodesign__artifact_batch', 'MCP error -32602: Input validation error: Invalid arguments for tool artifact_batch')).hookSpecificOutput.additionalContext;
    expect(text).toMatch(/没有执行/);
    expect(text).not.toMatch(/不要整批重跑/);
  });
  it('batch 中途失败仍走 batch 那支', async () => {
    const text = (await run('mcp__nodesign__browser_batch', 'FAILED at step 2/4 (browser_read): 选择器没匹配到元素')).hookSpecificOutput.additionalContext;
    expect(text).toMatch(/不要整批重跑/);
  });
  it('Bash E2BIG：教写成文件再执行', async () => {
    const text = (await run('Bash', 'Could not start /bin/bash: the command line plus environment exceed the OS exec argument limit (E2BIG).')).hookSpecificOutput.additionalContext;
    expect(text).toMatch(/Write 写成文件/);
  });
  it('WebFetch 取不到：换来源，不教重试', async () => {
    const text = (await run('WebFetch', 'Command failed with no output')).hookSpecificOutput.additionalContext;
    expect(text).toMatch(/换一个来源/);
    expect(text).not.toMatch(/先重试/);
  });
});

describe('failureSummary（09-18：问题库摘要原来截在缩进 JSON 里，看不到参数路径）', () => {
  const zodErr = 'MCP error -32602: Input validation error: Invalid arguments for tool write_on_board: ' + JSON.stringify([
    { expected: 'string', code: 'invalid_type', path: ['nodes', 0, 'text'], message: 'Invalid input: expected string, received undefined' },
  ], null, 2);

  it('⭐ 校验失败抽出参数路径和原因', () => {
    expect(failureSummary(zodErr)).toBe('入参校验：nodes.0.text Invalid input: expected string, received undefined');
  });

  it('原文被截在 500 字、JSON 不完整时按字面抽路径', () => {
    const cut = zodErr.slice(0, zodErr.indexOf('"message"') + 30);
    expect(failureSummary(cut)).toMatch(/^入参校验：nodes\.0\.text/);
  });

  it('别的错把空白压成一个空格', () => {
    expect(failureSummary('第一行\n\n   第二行')).toBe('第一行 第二行');
  });
});
