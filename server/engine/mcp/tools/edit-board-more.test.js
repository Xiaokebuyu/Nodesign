/**
 * edit_board 09-18 并进来的操作（站主：「把现有的 board 编辑工具都整合到 edit_board」）：
 * pin（多件一次排一排、拎出生成图文件夹是真搬）/ into_folder / arrange / set_vars；四个旧工具名不再注册。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-editmore-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeEditBoardTool } = await import('./edit-board.js');
const { arrangeLayout } = await import('./edit-board-more.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { renderChalk } = await import('../../../lib/chalk.js');

const pid = 'proj_editmore_0918';
let root; let edit; let editRp;
const put = async (rel, body = 'x') => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); };
const text = (r) => r.content[0].text;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  root = getSharedDir(pid);
  const ctx = { emit: () => {} };
  edit = (ops) => makeEditBoardTool({ projectId: pid, sharedRoot: root, ctx }).handler({ ops }, {});
  editRp = (ops) => makeEditBoardTool({ projectId: pid, sharedRoot: root, ctx, mode: 'rp' }).handler({ ops }, {});
  for (let i = 1; i <= 3; i += 1) await put(`assets/generated/cat-${i}.png`, 'png');
  await put('assets/generated/cat-1.webp', 'webp');
  await put('落地页/index.html', '<img src="../assets/generated/cat-1.webp">');
  await put('notes/板书/四只猫.md', renderChalk({ body: '四只猫', tag: '猫' }));
  await put('notes/板书/状态.md', renderChalk({ body: '| 键 | 值 |\n| --- | --- |\n| 好感度 | 1 |', tag: '状态表' }));
  await put('a.png'); await put('b.png'); await put('c.png');
  await patchBoard(pid, { zones: { 'assets/generated': { x: 2000, y: 0 } }, objects: {
    'notes/板书/四只猫.md': { x: 0, y: 0, w: 300, h: 80, tag: '猫' },
    'notes/板书/状态.md': { x: 0, y: 900, w: 300, h: 120, tag: '状态表' },
    'a.png': { x: 0, y: 400, w: 200, h: 176 }, 'b.png': { x: 900, y: 1400, w: 200, h: 176 }, 'c.png': { x: 1300, y: 300, w: 200, h: 176 },
  } });
});

describe('pin', () => {
  it('⭐ paths 一次摆三张：第一张贴 to，后面一张接一张往右；生成图是真搬出来，引用跟着改', async () => {
    const r = await edit([{ op: 'pin', paths: ['assets/generated/cat-1.png', 'assets/generated/cat-2.png', 'assets/generated/cat-3.png'], to: { by: 'notes/板书/四只猫.md', side: 'right' }, tag: '猫' }]);
    expect(r.isError).toBeUndefined();
    const b = await readBoard(pid);
    const c = [1, 2, 3].map((i) => b.objects[`cat-${i}.png`]);
    expect(c.every(Boolean)).toBe(true);
    expect(c[1].x).toBeGreaterThan(c[0].x); expect(c[2].x).toBeGreaterThan(c[1].x);
    expect(c.every((e) => e.tag === '猫')).toBe(true);
    await expect(fs.access(path.join(root, 'cat-1.webp'))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(root, '落地页/index.html'), 'utf8')).toContain('../cat-1.webp');
    expect(text(r)).toMatch(/Applied 1\/1/);
  });
});

describe('into_folder', () => {
  it('真搬进文件夹（不存在就建），画布身份跟走', async () => {
    const r = await edit([{ op: 'into_folder', ids: ['c.png'], folder: '素材' }]);
    expect(r.isError).toBeUndefined();
    await expect(fs.access(path.join(root, '素材/c.png'))).resolves.toBeUndefined();
    expect((await readBoard(pid)).objects['素材/c.png']).toBeTruthy();
  });
});

describe('arrange', () => {
  it('⭐ 几件按顺序排成一排、整块贴在 to 旁边、一起归进话题', async () => {
    const r = await edit([{ op: 'arrange', ids: ['a.png', 'b.png'], as: 'row', to: { by: 'notes/板书/四只猫.md', side: 'below' }, tag: '样张' }]);
    expect(r.isError).toBeUndefined();
    const b = await readBoard(pid);
    const [a, bb] = [b.objects['a.png'], b.objects['b.png']];
    expect(bb.y).toBe(a.y);
    expect(bb.x - a.x).toBe(200 + 24);
    expect(a.tag).toBe('样张'); expect(bb.tag).toBe('样张');
    expect(text(r)).toMatch(/2 件排成一排/);
  });

  it('不在板上的点名报，一件都不动', async () => {
    const r = await edit([{ op: 'arrange', ids: ['a.png', '没有.png'] }]);
    expect(text(r)).toMatch(/没有\.png/);
  });

  it('网格：列取最宽、行取最高', () => {
    const l = arrangeLayout([{ w: 100, h: 50 }, { w: 200, h: 80 }, { w: 120, h: 60 }, { w: 90, h: 40 }], 'grid', 2, 10);
    expect(l.at).toEqual([{ dx: 0, dy: 0 }, { dx: 130, dy: 0 }, { dx: 0, dy: 90 }, { dx: 130, dy: 90 }]);
    expect([l.w, l.h]).toEqual([330, 150]);
  });
});

describe('set_vars', () => {
  it('只改那一格；演出模式下这个 op 拒（状态归显示器）', async () => {
    const r = await edit([{ op: 'set_vars', vars: { 好感度: 3 } }]);
    expect(r.isError).toBeUndefined();
    expect(await fs.readFile(path.join(root, 'notes/板书/状态.md'), 'utf8')).toMatch(/好感度 \| 3/);
    const rp = await editRp([{ op: 'set_vars', vars: { 好感度: 4 } }]);
    expect(rp.isError).toBe(true);
    expect(text(rp)).toMatch(/演出模式/);
  });
});

describe('旧工具名不再注册', () => {
  it('⭐ 注册表里没有 pin_to_board / organize_board / set_vars / draw_trend', async () => {
    const src = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    for (const n of ['makePinToBoardTool', 'makeOrganizeBoardTool', 'makeSetVarsTool', 'makeDrawTrendTool']) expect(src).not.toContain(n);
  });
});
