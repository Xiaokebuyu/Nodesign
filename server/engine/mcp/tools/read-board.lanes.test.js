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
