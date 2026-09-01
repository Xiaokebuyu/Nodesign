import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-stack-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { openSheetFor } = await import('./open-sheet.js');
const { readBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { stacksOf, stackInvariantErrors, neighborStack } = await import('../../../lib/board-stacks.js');

const pid = 'proj_opensheet_stack';

describe('open_sheet 叠纸（2026-09-01 刀 3）', () => {
  beforeAll(async () => { await ensureProjectWorkspace(pid); });

  it('⭐ where:"stack" 铺在当前纸的同一块地上，两张纸坐标相等', async () => {
    const a = await openSheetFor(pid, { title: '第一拍' });
    const b = await openSheetFor(pid, { title: '第二拍', where: 'stack' });
    expect(b.basis).toBe('stack');
    expect({ x: b.x, y: b.y }).toEqual({ x: a.x, y: a.y });
    const board = await readBoard(pid);
    expect(board.sheets[b.id].stack).toBe(board.sheets[a.id].stack || a.id);
    expect(stackInvariantErrors(board)).toEqual([]);
  });

  it('⭐ 叠上去不许改整摞的名字（新一页的标题不是这一摞的标题）', async () => {
    const board = await readBoard(pid);
    const pile = stacksOf(board).find(p => p.sheets.length === 2);
    // 两页分别叫「第一拍」「第二拍」，整摞该跟着第一页，不是最上面那一页
    expect(pile.title).toBe('第一拍');
    expect(board.stacks[pile.name]?.title).toBeUndefined();
  });

  it('⭐ 点名一摞没见过的名字 = 在最右边另起一摞', async () => {
    const board0 = await readBoard(pid);
    const rightEdge = Math.max(...Object.values(board0.sheets).map(s => s.x + s.w));
    const st = await openSheetFor(pid, { title: '状态表', stack: 'state' });
    expect(st.basis).toBe('stack-new');
    expect(st.x).toBeGreaterThanOrEqual(rightEdge);
    const board = await readBoard(pid);
    expect(board.sheets[st.id].stack).toBe('state');
    expect(board.stacks.state).toMatchObject({ title: '状态表' });
  });

  it('⭐ 再点名同一摞就是叠上去，不是又开一摞', async () => {
    const first = (await readBoard(pid)).sheets;
    const firstState = Object.entries(first).find(([, s]) => s.stack === 'state');
    const again = await openSheetFor(pid, { title: '状态表 v2', stack: 'state' });
    expect(again.basis).toBe('stack');
    expect({ x: again.x, y: again.y }).toEqual({ x: firstState[1].x, y: firstState[1].y });
  });

  it('板上现在是两摞：左边主线（2 张）、右边状态表（2 张），左右换得过去', async () => {
    const board = await readBoard(pid);
    const piles = stacksOf(board);
    expect(piles).toHaveLength(2);
    expect(piles.map(p => p.sheets.length)).toEqual([2, 2]);
    expect(neighborStack(board, piles[0].name, 1).name).toBe(piles[1].name);
    expect(neighborStack(board, piles[1].name, 1)).toBeNull();
    expect(stackInvariantErrors(board)).toEqual([]);
  });

  it('缺省仍然是往下铺（前端会藏页之前不许翻案）', async () => {
    const p2 = 'proj_opensheet_stack_default';
    await ensureProjectWorkspace(p2);
    const a = await openSheetFor(p2, { title: '一' });
    const b = await openSheetFor(p2, { title: '二' });
    expect(b.basis).toBe('below-sheet');
    expect(b.y).toBeGreaterThan(a.y);
    expect((await readBoard(p2)).sheets[b.id].stack).toBeUndefined();
  });
});
