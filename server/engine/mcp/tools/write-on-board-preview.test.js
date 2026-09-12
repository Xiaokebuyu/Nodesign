/**
 * 流式预解算 × 真落板（2026-09-12，第 6 条收尾）：
 * 位置字段闭合那一拍 previewer.solve 解出的落点 = 之后同一个 toolUseId 真落板的落点（字不跳）；
 * 预留座进障碍集，同轮里别的落位躲它；落板后预留座取走。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-wob-preview-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeWriteOnBoardTool, makePreviewer } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { getReservation, reservationsIn, _resetReservations } = await import('../../../lib/board-reservations.js');
const { obstaclesIn } = await import('../../../lib/board-obstacles.js');

const pid = 'proj_wob_preview';
let sharedRoot; let tool; let previewer;
const extraFor = (id) => ({ _meta: { 'claudecode/toolUseId': id } });
const noteRect = async (text) => {
  const b = await readBoard(pid);
  for (const [id, e] of Object.entries(b.objects)) {
    if (!id.startsWith('notes/板书/')) continue;
    if ((await fs.readFile(path.join(sharedRoot, id), 'utf8')).includes(text)) return e;
  }
  return null;
};

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
  const ctx = { emit: () => {} };
  tool = makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx });
  previewer = ctx.spotPreviewers.mcp__nodesign__write_on_board;
  expect(previewer).toBe(ctx.spotPreviewers.mcp__nodesign__write_on_board);
  _resetViewpoints(); _resetReservations();
  await patchBoard(pid, { objects: { 'assets/锚.png': { x: 1000, y: 1000, w: 200, h: 176 } } });
  setViewpoint(pid, { camera: { x: 0, y: 0, w: 1600, h: 1000 }, layer: '' });
});

describe('预解算 = 真落板', () => {
  it('⭐ solve 先给出落点并登记预留座；同 toolUseId 落板落在同一处；落板后预留座取走', async () => {
    const solved = await previewer.solve({ near: 'assets/锚.png', text: '第一' }, 'toolu_A');
    expect(solved).toMatchObject({ zone: '', how: 'beside', side: 'right' });
    expect(solved.x).toBeGreaterThanOrEqual(1200);
    expect(getReservation(pid, 'toolu_A')).toMatchObject({ x: solved.x, y: solved.y });
    // 同轮里别的落位把预留座当障碍（id 同视点上报的直播框口径）
    expect(obstaclesIn(await readBoard(pid), '', { projectId: pid }).map(o => o.id)).toContain('live:toolu_A');
    // 正文继续流：预留高度跟着长
    previewer.grow('toolu_A', '第一段\n第二段\n第三段\n第四段\n第五段\n第六段');
    expect(getReservation(pid, 'toolu_A').h).toBeGreaterThan(solved.h);

    const r = await tool.handler({ near: 'assets/锚.png', text: '第一段写完了' }, extraFor('toolu_A'));
    expect(r.isError).toBeUndefined();
    const e = await noteRect('第一段写完了');
    expect({ x: e.x, y: e.y }).toEqual({ x: solved.x, y: solved.y });
    expect(getReservation(pid, 'toolu_A')).toBeNull();
    expect(reservationsIn(pid, '')).toEqual([]);
  });

  it('两条同时在流：第二条的预解算躲开第一条的预留座', async () => {
    const a = await previewer.solve({ near: 'assets/锚.png', text: 'x' }, 'toolu_B');
    const b = await previewer.solve({ near: 'assets/锚.png', text: 'y' }, 'toolu_C');
    const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    expect(overlap).toBe(false);
    _resetReservations();
  });

  it('解不出（锚不在板上 / 画的是图）返回 null，不登记', async () => {
    expect(await previewer.solve({ near: '虚空', text: 'x' }, 'toolu_D')).toBeNull();
    expect(await previewer.solve({ nodes: [{ text: 'a' }] }, 'toolu_E')).toBeNull();
    expect(getReservation(pid, 'toolu_D')).toBeNull();
  });
});
