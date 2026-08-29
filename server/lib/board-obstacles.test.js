/**
 * 占位契约刀 A：不住在 objects 里的东西也要占地方（2026-08-29）。
 *
 * 判据先验：光看"测试全绿"证明不了新障碍生效 —— 所以每条都给它一个**必须拦下的
 * 东西**（板书正正压在文件夹上），再配一发反向的（挪开就不许再报压），免得把闸
 * 装成"永远报 overlaps"也一样绿。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-obstacles-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { obstaclesIn } = await import('./board-obstacles.js');
const { sheetMembers, nextSpotInSheet } = await import('./board-sheets.js');
const { FOLDER_CARD } = await import('./board-kind-sizes.js');

describe('obstaclesIn —— 一层上谁占着地方', () => {
  const board = {
    objects: {
      'a.png': { x: 0, y: 0, w: 200, h: 176 },
      '角色/卡.md': { x: 10, y: 10, w: 300, h: 100, zone: '角色' },
    },
    zones: { 角色: { x: 500, y: 500 }, 素材: { x: 900, y: 500 } },
    rolls: {},
  };

  it('⭐ 文件夹卡进根层障碍集（这之前它对落位系统整个隐形）', () => {
    const ob = obstaclesIn(board, '');
    const ids = ob.map(o => o.id);
    expect(ids).toContain('角色');
    expect(ids).toContain('素材');
    expect(ids).toContain('a.png');
    const folder = ob.find(o => o.id === '角色');
    expect(folder).toMatchObject({ x: 500, y: 500, w: FOLDER_CARD.w, h: FOLDER_CARD.h });
  });

  it('文件夹层里没有文件夹卡（卡本身住在根层桌面上）', () => {
    const ids = obstaclesIn(board, '角色').map(o => o.id);
    expect(ids).toEqual(['角色/卡.md']);
  });

  it('exclude 对文件夹一样生效（挪文件夹时它不该跟自己比）', () => {
    const ids = obstaclesIn(board, '', { exclude: ['角色'] }).map(o => o.id);
    expect(ids).not.toContain('角色');
    expect(ids).toContain('素材');
  });

  it('坐标缺失的文件夹跳过，不造 (0,0) 幽灵障碍', () => {
    const ids = obstaclesIn({ ...board, zones: { ...board.zones, 空的: {} } }, '').map(o => o.id);
    expect(ids).not.toContain('空的');
  });

  it('卷卡也占一角（成员座位照旧留着，这条只为能报出"压住了卷标签"）', () => {
    const b = {
      objects: { 'x.png': { x: 100, y: 100, w: 200, h: 176, tag: '归档' } },
      zones: {},
      rolls: { 归档: { label: '归档', at: '2026-08-29' } },
    };
    expect(obstaclesIn(b, '').map(o => o.id)).toContain('roll:归档');
  });
});

describe('纸的成员含文件夹', () => {
  const board = {
    sheets: { p1: { x: 0, y: 0, w: 1000, h: 800, at: '2026-08-29T00:00:00Z' } },
    objects: {},
    zones: { 角色: { x: 100, y: 100 } },   // 中心 (244,220) 落在 p1 里
    rolls: {},
  };

  it('⭐ 文件夹在纸内 → 算纸的成员', () => {
    expect(sheetMembers(board, 'p1').map(m => m.id)).toEqual(['角色']);
  });

  it('⭐ 往下接排从文件夹底下起，不再排进它身体里', () => {
    const spot = nextSpotInSheet(board, 'p1', { w: 300, h: 100 });
    // 文件夹占到 y=100+240=340，接排要在它下面（含 gap）
    expect(spot.y).toBeGreaterThanOrEqual(100 + FOLDER_CARD.h);
  });

  it('纸外的文件夹不算成员', () => {
    const b = { ...board, zones: { 角色: { x: 5000, y: 5000 } } };
    expect(sheetMembers(b, 'p1')).toEqual([]);
  });
});

describe('端到端：板书压在文件夹上要如实报', () => {
  const pid = 'proj_obstacles_e2e';
  let write1; let open1;

  beforeAll(async () => {
    const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
    const { makeOpenSheetTool } = await import('../engine/mcp/tools/open-sheet.js');
    const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
    const { patchBoard } = await import('../projects/board-store.js');
    const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
    const { _resetSheetState } = await import('./sheet-state.js');
    await ensureProjectWorkspace(pid);
    _resetViewpoints(); _resetSheetState();
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    // 桌面上摆一个文件夹：世界 (100,100)，占到 (388,340)
    await patchBoard(pid, { zones: { 素材: { x: 100, y: 100 } } });
    const ctx = { emit() {} };
    const sharedRoot = getSharedDir(pid);
    open1 = (args = {}) => makeOpenSheetTool({ projectId: pid, sessionId: 'e2e', ctx }).handler(args, {});
    write1 = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'e2e', ctx }).handler(args, {});
    await open1({ title: '压测' });   // 纸对准视口 → 原点 (0,0)，版心从 (24,24) 起
  });

  it('⭐ 写在文件夹身上 → 返回文案点名压住了它', async () => {
    // 纸内局部 (76,76) = 世界 (100,100) = 文件夹左上角
    const r = await write1({ text: '正压在文件夹上', at: { x: 76, y: 76 } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/overlaps[^;]*素材/);
  });

  it('⭐ 反向：挪开就不许再报压（防止闸装成"永远报 overlaps"）', async () => {
    const r = await write1({ text: '离得远远的', at: { x: 700, y: 600 } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/overlaps[^;]*素材/);
  });
});
