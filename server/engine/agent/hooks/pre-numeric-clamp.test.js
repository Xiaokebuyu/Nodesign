/**
 * 数值越界夹紧钩子（2026-09-17）：查的是**真装配出来的**边界台账，不手塞。
 *
 * 理由同未知参数探针那条测试（lib/board-0830-fixes.test.js ⑤）：台账按 tool() 的裸名建、
 * 钩子拿到的是带前缀的名字，手塞台账会把名字对不上的洞盖住。所以先把真 MCP server 装起来。
 *
 * 「updatedInput 对进程内 MCP 工具生效、不带 permissionDecision」这两件是 SDK 行为，
 * 单测证明不了，09-17 用真 SDK 探针跑过三轮（结论写在 pre-numeric-clamp.js 头注释）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let clamp;
let registered;
beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-clamp-'));
  const { createNodesignMcpServer } = await import('../../mcp/index.js');
  const srv = createNodesignMcpServer({ workspaceRoot: tmp, sharedRoot: tmp, projectId: 'p_clamp', sessionId: 's', ctx: { emit() {} } });
  registered = srv.instance._registeredTools;
  const { makePreToolUseNumericClamp } = await import('./pre-numeric-clamp.js');
  clamp = makePreToolUseNumericClamp();
});

const call = (tool_name, tool_input) => clamp({ tool_name, tool_input });
const out = async (tool_name, tool_input) => (await call(tool_name, tool_input))?.hookSpecificOutput || null;
/**
 * 夹完的入参要能过这个工具真实的 zod schema —— 否则夹了也白夹。用的是 MCP server 注册表里
 * 那一份（SDK 已把 raw shape 包成 object），正是报 -32602 的那个校验器
 */
const passesZod = (bareName, input) => registered[bareName].inputSchema.safeParse(input).success;

describe('PreToolUse 数值越界夹紧：顶层与嵌套', () => {
  it('⭐⭐ browser_find limit 传 30（上限 20）→ 按 20 执行，并逐项说明', async () => {
    const input = { query: 'search', limit: 30 };
    expect(passesZod('browser_find', input)).toBe(false);   // 对照：不夹就被 zod 拒
    const o = await out('mcp__nodesign__browser_find', input);
    expect(o.updatedInput).toEqual({ query: 'search', limit: 20 });
    expect(o.additionalContext).toContain('参数 limit 传了 30，上限 20，已按 20 执行');
    expect(passesZod('browser_find', o.updatedInput)).toBe(true);
    expect(input.limit).toBe(30);   // 原入参不改
  });
  it('⭐⭐ 返回值不带 permissionDecision（带了会被其它钩子的 allow 抹掉，探针实测）', async () => {
    const o = await out('mcp__nodesign__browser_find', { query: 'x', limit: 30 });
    expect(o.hookEventName).toBe('PreToolUse');
    expect(o).not.toHaveProperty('permissionDecision');
  });
  it('⭐ screenshot_canvas settleMs 14000 → 10000；嵌套 viewport 的上下限同时夹', async () => {
    const o = await out('mcp__nodesign__screenshot_canvas', { settleMs: 14000, viewport: { width: 100, height: 9000 } });
    expect(o.updatedInput).toEqual({ settleMs: 10000, viewport: { width: 320, height: 2160 } });
    expect(o.additionalContext).toContain('参数 settleMs 传了 14000，上限 10000，已按 10000 执行');
    expect(o.additionalContext).toContain('参数 viewport.width 传了 100，下限 320，已按 320 执行');
    expect(passesZod('screenshot_canvas', o.updatedInput)).toBe(true);
  });
  it('⭐ write_on_board nodes[].w 240 → 120（嵌在数组对象里），其余节点原样', async () => {
    const input = { text: 'x', nodes: [{ id: 'a', text: '甲', w: 240 }, { id: 'b', text: '乙', w: 50 }] };
    const o = await out('mcp__nodesign__write_on_board', input);
    expect(o.updatedInput.nodes).toEqual([{ id: 'a', text: '甲', w: 120 }, { id: 'b', text: '乙', w: 50 }]);
    expect(o.additionalContext).toContain('参数 nodes[0].w 传了 240，上限 120，已按 120 执行');
    expect(o.updatedInput.text).toBe('x');
  });
  it('⭐ 下限：roll_dice n=0 → 1，edit_board 判别 union 里的 width=0 → 1', async () => {
    expect((await out('mcp__nodesign__roll_dice', { n: 0 })).updatedInput).toEqual({ n: 1 });
    const o = await out('mcp__nodesign__edit_board', { ops: [{ op: 'set_shape', id: 's1', width: 0 }, { op: 'transform_group', tag: 't', scale: 9 }] });
    expect(o.updatedInput.ops).toEqual([{ op: 'set_shape', id: 's1', width: 1 }, { op: 'transform_group', tag: 't', scale: 3 }]);
    expect(o.additionalContext).toContain('参数 ops[0].width 传了 0，下限 1，已按 1 执行');
    expect(passesZod('edit_board', o.updatedInput)).toBe(true);
  });
});

describe('PreToolUse 数值越界夹紧：不该动的不动', () => {
  it('⭐ 范围内的调用一声不吭', async () => {
    expect(await call('mcp__nodesign__browser_find', { query: 'x', limit: 5 })).toEqual({});
    expect(await call('mcp__nodesign__browser_find', { query: 'x' })).toEqual({});
  });
  it('⭐ 非数字、NaN 不动（留给 zod 报错）', async () => {
    expect(await call('mcp__nodesign__browser_find', { query: 'x', limit: '30' })).toEqual({});
    expect(await call('mcp__nodesign__browser_find', { query: 'x', limit: NaN })).toEqual({});
    expect(await call('mcp__nodesign__browser_find', { query: 'x', limit: null })).toEqual({});
  });
  it('⭐ 字符串超长、数组超长不夹（照旧由 zod 拒）', async () => {
    const longQuery = { query: 'q'.repeat(500), limit: 5 };
    expect(await call('mcp__nodesign__browser_find', longQuery)).toEqual({});
    expect(passesZod('browser_find', longQuery)).toBe(false);
    const manyFrames = { frames: Array.from({ length: 40 }, (_, i) => i) };
    expect(await call('mcp__nodesign__screenshot_canvas', manyFrames)).toEqual({});
    expect(passesZod('screenshot_canvas', manyFrames)).toBe(false);
    // 超长数组里越界的数值照夹，长度不动（长度仍交给 zod）
    const o = await out('mcp__nodesign__screenshot_canvas', { frames: [...manyFrames.frames, 99999] });
    expect(o.updatedInput.frames).toHaveLength(41);
    expect(o.updatedInput.frames[40]).toBe(30000);
  });
  it('非 nodesign 工具、没有数值边界的工具、非对象入参不管', async () => {
    expect(await call('Read', { file_path: '/x', limit: 1e9 })).toEqual({});
    expect(await call('mcp__other__browser_find', { query: 'x', limit: 30 })).toEqual({});
    expect(await call('mcp__nodesign__deliver_files', { files: [], x: 1e9 })).toEqual({});
    expect(await call('mcp__nodesign__browser_find', null)).toEqual({});
    expect(await clamp(undefined)).toEqual({});
  });
});

describe('PreToolUse 数值越界夹紧：batch', () => {
  it('⭐⭐ actions[].input 按子工具边界夹，裸名和带前缀的名字都认', async () => {
    const input = { actions: [
      { name: 'browser_find', input: { query: 'x', limit: 99 } },
      { name: 'browser_navigate', input: { url: 'https://example.com' } },
      { name: 'mcp__nodesign__browser_computer', input: { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', scroll_amount: 50 } },
    ] };
    const o = await out('mcp__nodesign__browser_batch', input);
    expect(o.updatedInput.actions[0].input).toEqual({ query: 'x', limit: 20 });
    expect(o.updatedInput.actions[1]).toBe(input.actions[1]);
    expect(o.updatedInput.actions[2].input.scroll_amount).toBe(10);
    expect(o.additionalContext).toContain('第 1 步 browser_find 的参数 limit 传了 99，上限 20，已按 20 执行');
    expect(o.additionalContext).toContain('第 3 步 browser_computer 的参数 scroll_amount 传了 50，上限 10，已按 10 执行');
    expect(o).not.toHaveProperty('permissionDecision');
    expect(input.actions[0].input.limit).toBe(99);   // 原入参不改
  });
  it('⭐ 写在 action 层（batch 会归位进 input）的参数、input.input 双层信封也夹', async () => {
    const o = await out('mcp__nodesign__artifact_batch', { actions: [
      { name: 'artifact_find', query: 'x', limit: 50 },
      { name: 'artifact_find', input: { input: { query: 'y', limit: 70 } } },
    ] });
    expect(o.updatedInput.actions[0]).toEqual({ name: 'artifact_find', query: 'x', limit: 20 });
    expect(o.updatedInput.actions[1].input.input).toEqual({ query: 'y', limit: 20 });
    expect(o.additionalContext).toContain('第 1 步 artifact_find 的参数 limit 传了 50');
    expect(o.additionalContext).toContain('第 2 步 artifact_find 的参数 limit 传了 70');
  });
  it('batch 里范围内 / 未注册的子工具 / 坏条目不响', async () => {
    expect(await call('mcp__nodesign__browser_batch', { actions: [{ name: 'browser_find', input: { query: 'x', limit: 3 } }] })).toEqual({});
    expect(await call('mcp__nodesign__browser_batch', { actions: [{ name: 'no_such_tool', input: { limit: 999 } }, null, 'x'] })).toEqual({});
    expect(await call('mcp__nodesign__browser_batch', { actions: 'nope' })).toEqual({});
  });
});
