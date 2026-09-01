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

  it('⭐ 续铺缺省是叠在当前这一摞上（2026-09-01 翻案）；name 点名可自定名字', async () => {
    const r = await open1({ name: 'act2', title: '第二幕' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const p1 = board.sheets.p1; const act2 = board.sheets.act2;
    expect(act2).toBeTruthy();
    expect({ x: act2.x, y: act2.y }, '同一块地').toEqual({ x: p1.x, y: p1.y });
    expect(currentSheetIdOf('s1')).toBe('act2');
  });

  it("where:'next' 仍然铺在正下方（隔一条沟）", async () => {
    const r = await open1({ name: 'below1', title: '往下一张', where: 'next' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.sheets.below1.y).toBeGreaterThanOrEqual(board.sheets.act2.y + board.sheets.act2.h);
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
   * ⭐⭐ 这条的答案翻过三次，把三次都留在这儿 —— 它们是同一个问题在不同前提下的答案：
   *
   *   08-29 刀 F  纸写满 → 拒收，**机器绝不替它翻页**
   *               （理由：机器悄悄翻页，agent 不知道自己换了页，新纸没有版面）
   *   08-31       纸写满 → 不拒收了，内容落暂存架（理由：拒收占了全系统工具失败的 1/4）
   *   09-01 刀 2  纸写满 → **机器翻到这一摞的下一页**
   *
   * ⭐ 第三次翻案不是把第一次推翻，是**第一次的理由没有了**：版位撤了，新一页
   * 不再"没有版面"—— 它跟上一页同一摞、同一套栏格，读的人一翻就到。
   */
  it('⭐⭐ 纸写满 → 机器翻到这一摞的下一页（不是拒收，也不是往下铺新纸）', async () => {
    const pid3 = 'proj_opensheet_full';
    await ensureProjectWorkspace(pid3);
    const w = (args) => makeWriteOnBoardTool({ projectId: pid3, sharedRoot: getSharedDir(pid3), sessionId: 's3', ctx: { emit() {} } }).handler(args, {});
    let turned = null;
    for (let i = 0; i < 40 && !turned; i += 1) {
      const r = await w({ text: `第 ${i} 段\n\n${'内容行\n'.repeat(10)}` });
      expect(r.isError, '纸满不该拒收').toBeUndefined();
      if (/turned to page/.test(r.content[0].text)) turned = r.content[0].text;
    }
    expect(turned, '连写这么多条都没填满，判据本身可疑').toBeTruthy();
    const board = await readBoard(pid3);
    expect(Object.keys(board.sheets).length).toBe(2);
    const [p1, p2] = Object.entries(board.sheets).sort(([, a2], [, b2]) => String(a2.at).localeCompare(String(b2.at)));
    // ⭐ 叠上去（同一块地），不是往下铺 —— 板子不长高才是这一刀的意义
    expect(p2[1].x).toBe(p1[1].x);
    expect(p2[1].y).toBe(p1[1].y);
    expect(p2[1].stack).toBe(p1[0]);
    // 会话的当前纸跟到新页上（下一条接着往那儿写）
    expect(currentSheetIdOf('s3')).toBe(p2[0]);
    // ⭐ 一件都没上架：翻页接住了，暂存架不该再有事做
    expect(Object.values(board.objects).filter((e) => e.seat === 'shelf')).toHaveLength(0);
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
