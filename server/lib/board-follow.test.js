import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-follow-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
const { makeEditBoardTool } = await import('../engine/mcp/tools/edit-board.js');
const { readBoard, patchBoard } = await import('../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');

const pid = 'proj_follow_test';
let write; let edit;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  const ctx = { emit: () => {} };
  const sharedRoot = getSharedDir(pid);
  write = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx }).handler(args);
  edit = (args) => makeEditBoardTool({ projectId: pid, sharedRoot, ctx }).handler(args);
});

describe('跟随线（状态板跟着最新章走，RP 案的正面解）', () => {
  it('follow 立规则一次，之后每章落板自动重指 + 挪组', async () => {
    // 状态板（常设组）+ 第一章
    await write({ staging: false, tag: '状态板', layout: 'column', nodes: [
      { id: 'pc', text: 'PC 卡' }, { id: 'dice', text: '明骰表' },
    ] });
    await write({ text: '第一章：出发', tag: '章节' });
    const r = await edit({ ops: [{ op: 'follow', group_tag: '状态板', target_tag: '章节', side: 'right' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('跟着');

    let board = await readBoard(pid);
    const followLine = Object.entries(board.bindings).find(([, b]) => b.follow === '章节');
    expect(followLine).toBeTruthy();
    const ch1 = Object.entries(board.objects).find(([id, e]) => e.tag === '章节' && id.includes('第一章'))[0];
    expect(followLine[1].to).toBe(ch1);

    // 第二章落板：线自动重指、状态板整组挪到新章右侧
    await write({ text: '第二章：迷雾', tag: '章节', chain: true });
    board = await readBoard(pid);
    const ch2 = Object.entries(board.objects).find(([id, e]) => e.tag === '章节' && id.includes('第二章'))[0];
    const line = board.bindings[followLine[0]];
    expect(line.to).toBe(ch2);
    const ch2e = board.objects[ch2];
    const panel = Object.entries(board.objects).filter(([, e]) => e.tag === '状态板');
    // 组在新章右侧（组内至少有成员 x 大于新章右缘附近）
    expect(Math.min(...panel.map(([, e]) => e.x))).toBeGreaterThan(ch2e.x);
  });

  it('用户拖过的成员不被跟随挪动，线仍重指', async () => {
    let board = await readBoard(pid);
    const [pcId] = Object.entries(board.objects).find(([, e]) => e.tag === '状态板' && e.data?.lid === 'pc');
    await patchBoard(pid, { objects: { [pcId]: { x: 99000, y: 99000, seat: 'user' } } });
    await write({ text: '第三章：雪原', tag: '章节', chain: true });
    board = await readBoard(pid);
    expect(board.objects[pcId].x).toBe(99000);   // user 座没动
    const line = Object.values(board.bindings).find(b => b.follow === '章节');
    const ch3 = Object.entries(board.objects).find(([id, e]) => e.tag === '章节' && id.includes('第三章'))[0];
    expect(line.to).toBe(ch3);                    // 线照样重指
  });

  it('unfollow 撤规则', async () => {
    const r = await edit({ ops: [{ op: 'unfollow', group_tag: '状态板' }] });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(Object.values(board.bindings).some(b => b.follow)).toBe(false);
  });

  it('follow 字段过两遍 sanitize 不掉（白名单钉子）', async () => {
    await patchBoard(pid, { bindings: { 'b:ftest': { type: 'annotates', from: 'a.md', to: 'b.md', follow: '章节', followSide: 'left' } } });
    await patchBoard(pid, { objects: { 'assets/poke.png': { x: 1, y: 1 } } });   // 触发一次读写循环
    const board = await readBoard(pid);
    expect(board.bindings['b:ftest'].follow).toBe('章节');
    expect(board.bindings['b:ftest'].followSide).toBe('left');
  });
});
