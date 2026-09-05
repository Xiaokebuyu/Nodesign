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

describe('端到端：文件夹卡是障碍，求解器绕开它', () => {
  const pid = 'proj_obstacles_e2e';
  let write1; let readBoard;
  const FOLDER = { x: 100, y: 100, w: FOLDER_CARD.w, h: FOLDER_CARD.h };
  const hits = (e) => !(e.x + e.w <= FOLDER.x || FOLDER.x + FOLDER.w <= e.x || e.y + e.h <= FOLDER.y || FOLDER.y + FOLDER.h <= e.y);

  beforeAll(async () => {
    const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
    const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
    const { patchBoard } = await import('../projects/board-store.js');
    const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
    ({ readBoard } = await import('../projects/board-store.js'));
    await ensureProjectWorkspace(pid);
    _resetViewpoints();
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    // 桌面上摆一个文件夹：世界 (100,100)，占到 (388,340)
    await patchBoard(pid, { zones: { 素材: { x: 100, y: 100 } } });
    const ctx = { emit() {} };
    const sharedRoot = getSharedDir(pid);
    write1 = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'e2e', ctx }).handler(args, {});
  });

  it('⭐ 落视口：第一块空地不是文件夹身上', async () => {
    const r = await write1({ text: '落在视口里' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/overlaps/);
    const board = await readBoard(pid);
    const id = Object.keys(board.objects).filter(i => i.startsWith('notes/板书/')).sort().pop();
    expect(hits(board.objects[id])).toBe(false);
  });

  it('⭐ 贴着文件夹写：真在它右侧，且返回点名它', async () => {
    const r = await write1({ text: '这个文件夹里是素材', place: { by: '素材', side: 'right' } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/right of 素材/);
    const board = await readBoard(pid);
    const id = Object.keys(board.objects).filter(i => i.startsWith('notes/板书/')).sort().pop();
    expect(board.objects[id].x).toBeGreaterThanOrEqual(FOLDER.x + FOLDER.w);
    expect(hits(board.objects[id])).toBe(false);
  });
});

describe('面积账三补（2026-09-05）', () => {
  it('⭐ 磁盘上已不存在的座位不当障碍（前端不画它，服务端也别绕它）', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-obs-stale-'));
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets/在.png'), 'x');
    const b = { objects: {
      'assets/在.png': { x: 0, y: 0 },
      'assets/没了.png': { x: 300, y: 0 },
      'deck:稿/index.html': { x: 600, y: 0 },
      'text:a1': { x: 900, y: 0, w: 100, h: 40, kind: 'text', data: { t: 'x' } },
    }, zones: {}, rolls: {} };
    const ids = obstaclesIn(b, '', { sharedRoot: root }).map(o => o.id);
    expect(ids).toContain('assets/在.png');
    expect(ids).toContain('text:a1');                 // 画布原生件没有文件本体，算在
    expect(ids).not.toContain('assets/没了.png');
    expect(ids).not.toContain('deck:稿/index.html');  // 前缀剥掉后按路径查，同样不在
    // 不给 sharedRoot：老口径，全算（调用方没法查盘时别偷偷少算）
    expect(obstaclesIn(b, '').map(o => o.id)).toContain('assets/没了.png');
  });

  it('⭐ 浏览器上报的临时占地（生图幻影）进障碍集，且只在同一层', async () => {
    const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
    _resetViewpoints();
    setViewpoint('proj_obs_ph', { camera: { x: 0, y: 0, w: 1000, h: 800 }, layer: '', occupied: [{ x: 500, y: 500, w: 200, h: 176 }, { x: 'bad' }] });
    const b = { objects: {}, zones: {}, rolls: {} };
    const root = obstaclesIn(b, '', { projectId: 'proj_obs_ph' });
    expect(root).toEqual([{ id: 'ph:1', x: 500, y: 500, w: 200, h: 176 }]);   // 坏矩形被 sanitize 丢掉
    expect(obstaclesIn(b, '素材', { projectId: 'proj_obs_ph' })).toEqual([]);   // 别的层看不见
    expect(obstaclesIn(b, '')).toEqual([]);                                     // 不给 projectId 不算
    _resetViewpoints();
  });

  it('⭐ 卷卡宽度算上「N 件 · 点开」那句：比只算标签宽出一截', () => {
    const b = { objects: { a: { x: 0, y: 0, tag: 'g' }, b: { x: 0, y: 100, tag: 'g' } }, zones: {}, rolls: { g: { label: '第一章' } } };
    const r = obstaclesIn(b, '').find(o => o.id === 'roll:g');
    expect(r.w).toBeGreaterThan(48 + 3 * 15 + 60);
    expect(r.h).toBe(40);
  });
});
