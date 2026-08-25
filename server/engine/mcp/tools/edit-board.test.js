import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-editboard-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeEditBoardTool, makeArrangeOnBoardAlias, makeRelateOnBoardAlias } = await import('./edit-board.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');

const pid = 'proj_editboard_test';
let sharedRoot;
let edit; let write;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
  const ctx = { emit: () => {} };
  edit = (args) => makeEditBoardTool({ projectId: pid, sharedRoot, ctx }).handler(args);
  write = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx }).handler(args);
});

describe('edit_board（吞四件 + 新能力）', () => {
  it('set_edge 改端点：重指一条命令（RP「状态锚在这一章」案）', async () => {
    await write({ nodes: [{ id: 'ch1', text: '第一章' }, { id: 'ch2', text: '第二章' }, { id: 'status', text: '状态板' }], tag: 'rp' });
    let board = await readBoard(pid);
    const idOf = (lid) => Object.entries(board.objects).find(([, e]) => e.data?.lid === lid)?.[0];
    const r0 = await edit({ tag: 'rp', ops: [{ op: 'add_edge', from: 'status', to: 'ch1', type: 'annotates', label: '状态锚' }] });
    expect(r0.isError).toBeUndefined();
    board = await readBoard(pid);
    const [edgeId, e0] = Object.entries(board.bindings).find(([, b]) => b.label === '状态锚');
    expect(e0.to).toBe(idOf('ch1'));
    const r1 = await edit({ tag: 'rp', ops: [{ op: 'set_edge', id: edgeId, to: 'ch2' }] });
    expect(r1.isError).toBeUndefined();
    board = await readBoard(pid);
    expect(board.bindings[edgeId].to).toBe(idOf('ch2'));
    expect(board.bindings[edgeId].from).toBe(idOf('status'));
  });

  it('set_edge 新端点不存在：拒这一条，其余照做', async () => {
    const board = await readBoard(pid);
    const edgeId = Object.keys(board.bindings)[0];
    const r = await edit({ ops: [{ op: 'set_edge', id: edgeId, to: '不存在的东西' }, { op: 'unfeature' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('✗ #1');
  });

  it('reflow：set_text 改高后整组按 column 重堆，不再叠字（RP 状态板案）', async () => {
    await write({
      layout: 'column', tag: 'panel', staging: false,
      nodes: [{ id: 'pc', text: 'PC 卡' }, { id: 'scene', text: '当前场景' }, { id: 'dice', text: '骰子记录' }],
    });
    let board = await readBoard(pid);
    const idOf = (lid) => Object.entries(board.objects).find(([, e]) => e.data?.lid === lid)?.[0];
    const long = Array.from({ length: 12 }, (_, i) => `| 第${i}章 | 检定 | DC | 结果 |`).join('\n');
    const r = await edit({ tag: 'panel', ops: [{ op: 'set_text', id: 'scene', text: long, format: 'md' }, { op: 'reflow', tag: 'panel' }] });
    expect(r.isError).toBeUndefined();
    board = await readBoard(pid);
    const scene = board.objects[idOf('scene')];
    const dice = board.objects[idOf('dice')];
    // 骰子记录被推到变高后的场景卡下面，不重叠
    expect(dice.y).toBeGreaterThanOrEqual(scene.y + scene.h);
  });

  it('reflow 跳过用户拖过的（seat:user 永不被重排）', async () => {
    let board = await readBoard(pid);
    const idOf = (lid) => Object.entries(board.objects).find(([, e]) => e.data?.lid === lid)?.[0];
    const diceId = idOf('dice');
    await patchBoard(pid, { objects: { [diceId]: { x: 5000, y: 5000, seat: 'user' } } });
    const r = await edit({ ops: [{ op: 'reflow', tag: 'panel' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('跳过用户拖过的');
    board = await readBoard(pid);
    expect(board.objects[diceId].x).toBe(5000);
  });

  it('remove：agent 自己的板书放行，文件+座位一起清', async () => {
    await write({ text: '临时便签，一会儿删' });
    let board = await readBoard(pid);
    const chalkId = Object.keys(board.objects).filter(id => id.startsWith('notes/板书/')).sort().pop();
    const abs = path.join(sharedRoot, chalkId);
    await fs.access(abs);   // 文件在
    const r = await edit({ ops: [{ op: 'remove', id: chalkId }] });
    expect(r.isError).toBeUndefined();
    board = await readBoard(pid);
    expect(board.objects[chalkId]).toBeUndefined();
    await expect(fs.access(abs)).rejects.toThrow();
    // 软删：真身进了 .nd/trash/<日期>/（08-25 信箱：rm 后无法恢复案）
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const trashed = await fs.readdir(path.join(sharedRoot, '.nd', 'trash', day));
    expect(trashed.some(n => n === path.basename(abs))).toBe(true);
  });

  it('remove：用户的板书拒删', async () => {
    await patchBoard(pid, { objects: { 'notes/板书/user-note.md': { x: 0, y: 0, by: 'user' } } });
    const r = await edit({ ops: [{ op: 'remove', id: 'notes/板书/user-note.md' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('用户的板书');
  });

  it('add_edge：端点校验下沉（不存在拒；磁盘真身收）', async () => {
    await fs.writeFile(path.join(sharedRoot, '真实文件.md'), 'x', 'utf8');
    const bad = await edit({ ops: [{ op: 'add_edge', from: '真实文件.md', to: '虚空端点' }] });
    expect(bad.isError).toBe(true);
    await patchBoard(pid, { objects: { 'assets/photo.png': { x: 10, y: 10 } } });
    const good = await edit({ ops: [{ op: 'add_edge', from: '真实文件.md', to: 'assets/photo.png', type: 'ref' }] });
    expect(good.isError).toBeUndefined();
  });

  it('move 有避让：目标位被占就近落，返回说清楚', async () => {
    await patchBoard(pid, { objects: {
      'assets/a.png': { x: 9000, y: 9000, w: 200, h: 176 },
      'assets/b.png': { x: 9224, y: 9000, w: 200, h: 176 },   // 正占着 a 的右侧
      'assets/c.png': { x: 20000, y: 20000, w: 200, h: 176 },
    } });
    const r = await edit({ ops: [{ op: 'move', id: 'assets/c.png', to: { ref: 'assets/a.png', side: 'right' } }] });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const c = board.objects['assets/c.png'];
    const b = board.objects['assets/b.png'];
    // 不压在 b 上
    expect(c.x + 200 <= b.x || b.x + 200 <= c.x || c.y + 176 <= b.y || b.y + 176 <= c.y).toBe(true);
    expect(c.seat).toBe('agent');
  });

  it('feature/unfeature（吞 arrange）+ commit/erase_group（吞 finish）', async () => {
    const r = await edit({ ops: [{ op: 'feature', id: 'assets/photo.png' }] });
    expect(r.isError).toBeUndefined();
    let board = await readBoard(pid);
    expect(board.hero).toBe('assets/photo.png');
    await edit({ ops: [{ op: 'unfeature' }] });
    board = await readBoard(pid);
    expect(board.hero).toBeUndefined();

    await write({ nodes: [{ id: 'x1', text: 'X' }, { id: 'x2', text: 'Y' }], tag: 'wipe' });
    const c = await edit({ ops: [{ op: 'commit', tag: 'wipe' }] });
    expect(c.content[0].text).toContain('落定');
    const e = await edit({ ops: [{ op: 'erase_group', tag: 'wipe' }] });
    expect(e.content[0].text).toContain('擦掉');
    board = await readBoard(pid);
    expect(Object.values(board.objects).some(o => o.tag === 'wipe')).toBe(false);
  });

  it('arrange_on_board 别名：beside 转发 move', async () => {
    const alias = makeArrangeOnBoardAlias({ projectId: pid, sharedRoot, ctx: { emit: () => {} } });
    const r = await alias.handler({ action: 'beside', subject: 'assets/photo.png', anchor: 'assets/a.png' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.objects['assets/photo.png'].x).toBeGreaterThan(9000);
  });

  it('relate_on_board 别名：悬空端点照拒（口径病收口）', async () => {
    const alias = makeRelateOnBoardAlias({ projectId: pid, sharedRoot, ctx: { emit: () => {} } });
    const bad = await alias.handler({ type: 'ref', from: 'assets/photo.png', to: 'relations' });
    expect(bad.isError).toBe(true);
    const good = await alias.handler({ type: 'contrast', from: 'assets/a.png', to: 'assets/b.png' });
    expect(good.isError).toBeUndefined();
  });
});
