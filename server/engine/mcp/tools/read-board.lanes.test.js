// read_board 的版图一节（08-27 空间规划）—— 符号地图真的渲染出来
//
// read_board 之前没有任何测试在跑它的 handler；版图节引用 laneSummaries，
// 一个 import 打错就是「read_board 整个坏掉」级别的静默炸弹，这里最少冒烟一发。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-readboard-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeReadBoardTool } = await import('./read-board.js');
const { patchBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getSharedDir } = await import('../../../projects/workspace.js');

const pid = 'proj_readboard_lanes';
let call;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  const t = makeReadBoardTool({ projectId: pid, sharedRoot: getSharedDir(pid) });
  call = (args = {}) => t.handler(args, {});
  await patchBoard(pid, {
    objects: {
      'assets/a.png': { x: 0, y: 0, w: 200, h: 176 },
      'assets/b.png': { x: 0, y: 300, w: 200, h: 176, tag: '主线' },
      'assets/c.png': { x: 0, y: 600, w: 200, h: 176, tag: '主线' },
    },
    lanes: { 主线: { x: 0, y: 300, w: 480 } },
  });
});

describe('read_board 版图', () => {
  it('⭐ 已注册的线报节数与 frontier；口径行仍在', async () => {
    const r = await call();
    const text = r.content[0].text;
    expect(text).toContain('版图');
    expect(text).toMatch(/#主线：2 节/);
    expect(text).toContain('接着写会落');
    expect(text).toContain('口径');
  });

  it('tag 过滤视图不渲染版图节（那是全局地图）', async () => {
    const r = await call({ tag: '主线' });
    expect(r.content[0].text).not.toContain('版图（');
  });
});

describe('版图走向（08-27 落位直觉可见化）', () => {
  it('⭐ 用户把一条线掰横 → 版图行报「走向 →右（用户摆的）」', async () => {
    await patchBoard(pid, {
      objects: {
        'notes/板书/h1.md': { x: 2000, y: 0, w: 400, h: 200, by: 'agent', tag: '横线', seat: 'agent' },
        'notes/板书/h2.md': { x: 2560, y: 20, w: 400, h: 200, by: 'agent', tag: '横线', seat: 'user' },
        'notes/板书/h3.md': { x: 3120, y: 0, w: 400, h: 200, by: 'agent', tag: '横线', seat: 'user' },
      },
      bindings: {
        'b:h1': { type: 'flow', from: 'notes/板书/h1.md', to: 'notes/板书/h2.md', tag: '横线' },
        'b:h2': { type: 'flow', from: 'notes/板书/h2.md', to: 'notes/板书/h3.md', tag: '横线' },
      },
    });
    const r = await call();
    const text = r.content[0].text;
    expect(text).toMatch(/#横线：.*走向 →右（用户摆的，接楼会跟）/);
    // 没被掰过的线不带走向段（拿不准就不占字）
    expect(text).not.toMatch(/#主线：.*走向/);
  });
});

describe('收卷（2026-08-27 收纳器）', () => {
  it('⭐ 收着的线：版图一行带过，成员不逐件列；显式 tag= 点名仍展开', async () => {
    await patchBoard(pid, {
      objects: {
        'assets/旧章图a.png': { x: 5000, y: 5000, w: 200, h: 160, tag: '旧章' },
        'assets/旧章图b.png': { x: 5000, y: 5200, w: 200, h: 160, tag: '旧章' },
      },
      rolls: { '旧章': { by: 'agent', label: '第一章存档' } },
    });
    const r = await call();
    const text = r.content[0].text;
    expect(text).toMatch(/#旧章：已收卷（「第一章存档」）/);
    expect(text).toContain('unroll');
    expect(text).not.toContain('旧章图a.png');   // 逐件列表被收敛
    // 点名看这组：照常展开列（agent 主动要看就给看）
    const r2 = await call({ tag: '旧章' });
    expect(r2.content[0].text).toContain('旧章图a.png');
  });
});
