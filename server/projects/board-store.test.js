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

describe('sheets 注册表（2026-08-29 纸范式）：合并语义同 lanes', () => {
  const sp = 'proj_boardstore_sheets';
  beforeAll(async () => { const { ensureProjectWorkspace } = await import('./workspace.js'); await ensureProjectWorkspace(sp); });

  it('落盘读得回（含 by/at/title）', async () => {
    await patchBoard(sp, { sheets: { p1: { x: 0, y: 0, w: 1867, h: 1200, by: 'agent', at: '2026-08-29T01:00:00Z', title: '开工' } } });
    const b = await readBoard(sp);
    expect(b.sheets.p1).toMatchObject({ x: 0, y: 0, w: 1867, h: 1200, by: 'agent', title: '开工' });
  });

  it('瘦 patch 合并不抹字段；null 删除；删空后整个键消失', async () => {
    await patchBoard(sp, { sheets: { p1: { title: '第一章' } } });
    let b = await readBoard(sp);
    expect(b.sheets.p1).toMatchObject({ x: 0, y: 0, w: 1867, h: 1200, by: 'agent', title: '第一章' });
    await patchBoard(sp, { sheets: { p1: null } });
    b = await readBoard(sp);
    expect(b.sheets).toBeUndefined();
  });

  /**
   * 版位（2026-08-29 刀 E）。⚠️ sanitize 是**白名单重建**：新字段不显式登记就静默丢，
   * 而丢了的表现是"agent 规划完版面，下一句就说没有这块地" —— 不报错。
   * 所以每个新字段都配一条「过两遍不掉」。
   */
  it('⭐ slots 过两遍不掉（白名单重建陷阱）', async () => {
    const sp2 = 'proj_boardstore_slots';
    await patchBoard(sp2, { sheets: { p1: {
      x: 0, y: 0, w: 2000, h: 900, by: 'agent', at: '2026-08-29T01:00:00Z',
      slots: {
        main: { x: 0, y: 0, w: 432, h: 360, about: '正文' },
        aside: { x: 460, y: 0, w: 288, h: 200 },
      },
    } } });
    const b1 = await readBoard(sp2);
    expect(Object.keys(b1.sheets.p1.slots)).toEqual(['main', 'aside']);
    expect(b1.sheets.p1.slots.main).toEqual({ x: 0, y: 0, w: 432, h: 360, about: '正文' });
    // 再存一遍读出来还在（过两遍）
    await patchBoard(sp2, { sheets: { p1: { title: '第二章' } } });
    const b2 = await readBoard(sp2);
    expect(b2.sheets.p1.slots.main).toEqual({ x: 0, y: 0, w: 432, h: 360, about: '正文' });
    expect(b2.sheets.p1.title).toBe('第二章');
  });

  it('太小的地和名字非法的地被丢掉（放不下一行字的不算一块地）', async () => {
    const sp3 = 'proj_boardstore_slots2';
    await patchBoard(sp3, { sheets: { p1: {
      x: 0, y: 0, w: 2000, h: 900,
      slots: { ok: { x: 0, y: 0, w: 200, h: 100 }, tiny: { x: 0, y: 0, w: 10, h: 10 }, 'bad name!': { x: 0, y: 0, w: 200, h: 100 } },
    } } });
    const b = await readBoard(sp3);
    expect(Object.keys(b.sheets.p1.slots)).toEqual(['ok']);
  });


  it('坏名静默丢弃，不炸整个 patch', async () => {
    await patchBoard(sp, { sheets: { 'bad name!!': { x: 0, y: 0 }, p9: { x: 10, y: 10 } } });
    const b = await readBoard(sp);
    expect(b.sheets['bad name!!']).toBeUndefined();
    expect(b.sheets.p9).toMatchObject({ x: 10, y: 10 });
  });
});
