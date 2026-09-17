// read_board 按关系说位置（09-11）：像素只在 coords:true 时给。
// 09-17 板书树刀一：分组座次表换成大纲（谁挂在谁下面），同 tag 的成员挂在组长下面。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-readboard-rel-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeReadBoardTool } = await import('./read-board.js');
const { patchBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getSharedDir } = await import('../../../projects/workspace.js');

const pid = 'proj_readboard_rel';
let call;
const node = (x, y, t, tag) => ({ x, y, w: 300, h: 120, kind: 'text', data: { t }, tag });

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  const t = makeReadBoardTool({ projectId: pid, sharedRoot: getSharedDir(pid) });
  call = (args = {}) => t.handler(args, {});
  await patchBoard(pid, {
    objects: {
      'text:t1': node(0, 0, '甲', '两列'), 'text:t2': node(400, 0, '乙', '两列'),
      'text:t3': node(0, 200, '丙', '两列'), 'text:t4': node(400, 200, '丁', '两列'),
      'text:u1': node(1200, 0, '右一', '右组'), 'text:u2': node(1200, 200, '右二', '右组'),
    },
  });
});

describe('read_board 按关系说位置', () => {
  it('默认不给像素；大纲按缩进说谁挂在谁下面', async () => {
    const text = (await call()).content[0].text;
    expect(text).not.toMatch(/@\(-?\d+,-?\d+\)/);
    expect(text).not.toContain('内容范围');
    expect(text).toContain('大纲（谁挂在谁下面）');
    expect(text).toMatch(/^- \[手写\] 「甲」[^\n]*#两列$/m);       // 组长在第一层
    expect(text).toMatch(/^ {2}- \[手写\] 「乙」[^\n]*#两列$/m);    // 成员挂在组长下面，只缩一层
    expect(text).toMatch(/^- \[手写\] 「右一」[^\n]*#右组$/m);      // 另一个组自成一支
    expect(text).not.toMatch(/右侧 \d+px/);
  });

  it('tag= 点名只列那一组，仍是大纲形状', async () => {
    const text = (await call({ tag: '两列' })).content[0].text;
    const at = (s2) => text.indexOf(s2);
    expect(at('「甲」')).toBeLessThan(at('「乙」'));
    expect(text).not.toContain('「右一」');
    expect(text).toMatch(/^ {2}- \[手写\] 「丁」/m);
  });

  it('coords:true 才给像素', async () => {
    const text = (await call({ coords: true })).content[0].text;
    expect(text).toMatch(/@\(0,0\) 300x120/);
    expect(text).toContain('内容范围');
  });
});
