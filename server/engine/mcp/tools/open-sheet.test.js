/**
 * open_sheet 铺纸 + 纸流程集成（2026-08-29 纸范式刀 2）。
 * 判据先验：铺纸对准视口、续铺在正下方、当前纸指针、写满翻纸 —— 每条一发。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-opensheet-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeOpenSheetTool } = await import('./open-sheet.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { readBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { _resetSheetState, currentSheetIdOf } = await import('../../../lib/sheet-state.js');
const { SHEET_MARGIN } = await import('../../../lib/board-sheets.js');

const pid = 'proj_opensheet_test';
let open1; let write1;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  const sharedRoot = getSharedDir(pid);
  const ctx = { emit() {} };
  open1 = (args = {}) => makeOpenSheetTool({ projectId: pid, sessionId: 's1', ctx }).handler(args, {});
  write1 = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx }).handler(args, {});
});

describe('open_sheet 铺纸', () => {
  it('⭐ 第一张对准用户视口，成为当前纸；返回报可写区', async () => {
    _resetViewpoints(); _resetSheetState();
    setViewpoint(pid, { camera: { x: 500, y: 700, w: 1400, h: 900 }, zoom: 1 });
    const r = await open1({ title: '开工' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Sheet p1 laid/);
    expect(r.content[0].text).toMatch(/current sheet/);
    const board = await readBoard(pid);
    const s = board.sheets.p1;
    expect(s.title).toBe('开工');
    expect(Math.abs(s.x - 500)).toBeLessThanOrEqual(24);   // 对准视口（snap 到格）
    expect(Math.abs(s.y - 700)).toBeLessThanOrEqual(24);
    expect(currentSheetIdOf('s1')).toBe('p1');
  });

  it('续铺缺省在当前纸正下方；name 点名可自定名字', async () => {
    const r = await open1({ name: 'act2', title: '第二幕' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const p1 = board.sheets.p1; const act2 = board.sheets.act2;
    expect(act2).toBeTruthy();
    expect(act2.y).toBeGreaterThanOrEqual(p1.y + p1.h);    // 正下方（隔沟）
    expect(currentSheetIdOf('s1')).toBe('act2');
  });

  it("where:'viewport' 把工作拉回用户眼皮底下", async () => {
    setViewpoint(pid, { camera: { x: 30000, y: 30000, w: 1400, h: 900 }, zoom: 1 });
    const r = await open1({ where: 'viewport' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const ids = Object.keys(board.sheets);
    const latest = ids.find(i => board.sheets[i].x >= 29000);
    expect(latest).toBeTruthy();
  });
});

describe('write_on_board 的纸流程', () => {
  it('没铺过纸的项目第一笔自动铺纸（返回说明 opened sheet）', async () => {
    _resetViewpoints(); _resetSheetState();
    const pid2 = 'proj_opensheet_auto';
    await ensureProjectWorkspace(pid2);
    const w = (args) => makeWriteOnBoardTool({ projectId: pid2, sharedRoot: getSharedDir(pid2), sessionId: 's2', ctx: { emit() {} } }).handler(args, {});
    const r = await w({ text: '开工第一句' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/opened sheet p1/);
    const board = await readBoard(pid2);
    expect(board.sheets.p1).toBeTruthy();
    const note = Object.entries(board.objects).find(([id]) => id.startsWith('notes/板书/'));
    // 落在纸的版心顶端
    expect(note[1].x).toBe(board.sheets.p1.x + SHEET_MARGIN);
    expect(note[1].y).toBe(board.sheets.p1.y + SHEET_MARGIN);
  });

  /**
   * ⚠️ 08-29 刀 F 改了这条的答案：纸写满**不再自动翻页**。
   * 站主拍板「每张纸规划一次摆放」—— 机器悄悄翻页的话 agent 根本不知道自己换了页，
   * 新纸自然也没有版面（真会话 proj_mtfhey1x：p2 规划得好好的，写满翻到 p3 就散了）。
   * 纸是它开的，满了该由它决定下一页什么样。
   */
  it('⭐ 纸写满 → 拒收并让它自己规划下一页，不替它翻页', async () => {
    const pid3 = 'proj_opensheet_full';
    await ensureProjectWorkspace(pid3);
    const w = (args) => makeWriteOnBoardTool({ projectId: pid3, sharedRoot: getSharedDir(pid3), sessionId: 's3', ctx: { emit() {} } }).handler(args, {});
    let refused = null;
    for (let i = 0; i < 40; i += 1) {
      const r = await w({ text: `第 ${i} 段\n\n${'内容行\n'.repeat(10)}` });
      if (r.isError) { refused = r.content[0].text; break; }
    }
    expect(refused, '连写这么多条都没填满，判据本身可疑').toBeTruthy();
    expect(refused).toMatch(/is full/);
    expect(refused).toMatch(/nothing was written/i);
    expect(refused).toMatch(/open_sheet\{title/);
    // 没有替它铺新纸
    const board = await readBoard(pid3);
    expect(Object.keys(board.sheets).length).toBe(1);
    expect(currentSheetIdOf('s3')).toBe('p1');
  });

  it('sheet 点名：写到指定的纸上而不是当前纸', async () => {
    const r = await write1({ text: '写回第一张', sheet: 'p1', at: { x: 100, y: 900 } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/on sheet p1/);
    const board = await readBoard(pid);
    const note = Object.entries(board.objects)
      .filter(([id]) => id.startsWith('notes/板书/'))
      .map(([, e]) => e)
      .find(e => e.x === board.sheets.p1.x + SHEET_MARGIN + 100);
    expect(note).toBeTruthy();
  });
});
