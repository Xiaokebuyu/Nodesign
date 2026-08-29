import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-boardstore-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { readBoard, patchBoard } = await import('./board-store.js');
const { ensureProjectWorkspace } = await import('./workspace.js');

const pid = 'proj_boardstore_test';

describe('patchBoard 合并语义（08-25：前端瘦条目回写不再抹字段）', () => {
  beforeAll(async () => { await ensureProjectWorkspace(pid); });

  it('胖条目落盘后，{x,y,z} 瘦 patch 只更新坐标，by/seat/w/h/tag 全保留', async () => {
    await patchBoard(pid, { objects: { 'notes/板书/a.md': {
      x: 100, y: 200, z: 1, w: 432, h: 195, by: 'agent', seat: 'agent', tag: '章节',
    } } });
    // 模拟前端入座/回写的瘦条目（08-25 体检：BoardCanvas 607 那一发）
    await patchBoard(pid, { objects: { 'notes/板书/a.md': { x: 304, y: 266, z: 2 } } });
    const board = await readBoard(pid);
    expect(board.objects['notes/板书/a.md']).toMatchObject({
      x: 304, y: 266, z: 2, w: 432, h: 195, by: 'agent', seat: 'agent', tag: '章节',
    });
  });

  it('null 仍是整条删除', async () => {
    await patchBoard(pid, { objects: { 'assets/x.png': { x: 1, y: 2 } } });
    await patchBoard(pid, { objects: { 'assets/x.png': null } });
    const board = await readBoard(pid);
    expect(board.objects['assets/x.png']).toBeUndefined();
  });

  it('seat 三值收、其余拒；过两遍读写不掉（白名单重建的钉子）', async () => {
    await patchBoard(pid, { objects: {
      'assets/u.png': { x: 0, y: 0, seat: 'user' },
      'assets/v.png': { x: 0, y: 0, seat: 'robot' },
    } });
    // 第二遍读写（readBoard→writeBoard 全走 sanitize）
    await patchBoard(pid, { objects: { 'assets/w.png': { x: 9, y: 9 } } });
    const board = await readBoard(pid);
    expect(board.objects['assets/u.png'].seat).toBe('user');
    expect(board.objects['assets/v.png'].seat).toBeUndefined();
  });

  it('objects 的 by 收 user（与 bindings 口径对齐）', async () => {
    await patchBoard(pid, { objects: { 'text:byuser': { x: 0, y: 0, kind: 'text', data: { t: '手写' }, by: 'user' } } });
    const board = await readBoard(pid);
    expect(board.objects['text:byuser'].by).toBe('user');
  });
});

describe('lanes 注册表（08-27 空间规划）：持久在 board.json、合并语义、坏名丢弃', () => {
  const lp = 'proj_boardstore_lanes';
  beforeAll(async () => { await ensureProjectWorkspace(lp); });

  it('⭐ patch 落盘 → readBoard 读得回（sanitize 白名单没把它剥掉）', async () => {
    await patchBoard(lp, { lanes: { 主线: { x: 100, y: 0, w: 480 }, 支线: { x: 700, y: 40, w: 480, parent: 'notes/板书/a.md' } } });
    const b = await readBoard(lp);
    expect(b.lanes['主线']).toEqual({ x: 100, y: 0, w: 480 });
    expect(b.lanes['支线'].parent).toBe('notes/板书/a.md');
  });

  it('瘦 patch 合并不抹字段；null 删除；删空后整个键消失', async () => {
    await patchBoard(lp, { lanes: { 支线: { y: 64 } } });
    let b = await readBoard(lp);
    expect(b.lanes['支线']).toMatchObject({ x: 700, y: 64, parent: 'notes/板书/a.md' });
    await patchBoard(lp, { lanes: { 主线: null, 支线: null } });
    b = await readBoard(lp);
    expect(b.lanes).toBeUndefined();
  });

  it('坏名（过不了 tag 白名单）静默丢弃，不炸整个 patch', async () => {
    await patchBoard(lp, { lanes: { 'bad name!!': { x: 0, y: 0 }, 好名: { x: 10, y: 10 } } });
    const b = await readBoard(lp);
    expect(b.lanes['bad name!!']).toBeUndefined();
    expect(b.lanes['好名']).toEqual({ x: 10, y: 10, w: 480 });
  });
});
