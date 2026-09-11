// read_board 按关系说位置（09-11）：像素只在 coords:true 时给；多列的组先按列再按上下列。
// 起因：读到像素的 agent 会在坐标系里推算（「离组 600+px」的误报），按行读又把两列交错成一串。
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
  it('默认不给像素；组的概况说件数、列数、谁在谁的哪一侧', async () => {
    const text = (await call()).content[0].text;
    expect(text).not.toMatch(/@\(-?\d+,-?\d+\)/);
    expect(text).not.toContain('内容范围');
    expect(text).toMatch(/#两列：4 件；2 列（2\/2 件）/);
    expect(text).toMatch(/#右组：2 件；单列；在 #两列 的右侧（顶齐）/);
    expect(text).not.toMatch(/右侧 \d+px/);
  });

  it('两列的组先列完第一列再列第二列，每件标第几列（不再按行交错）', async () => {
    const text = (await call({ tag: '两列' })).content[0].text;
    const at = (s) => text.indexOf(s);
    expect(at('「甲」')).toBeLessThan(at('「丙」'));
    expect(at('「丙」')).toBeLessThan(at('「乙」'));
    expect(at('「乙」')).toBeLessThan(at('「丁」'));
    expect(text).toMatch(/- 第1列 \[手写\] 「甲」/);
    expect(text).toMatch(/- 第2列 \[手写\] 「丁」/);
  });

  it('coords:true 才给像素', async () => {
    const text = (await call({ coords: true })).content[0].text;
    expect(text).toMatch(/@\(0,0\) 300x120/);
    expect(text).toContain('内容范围');
  });
});
