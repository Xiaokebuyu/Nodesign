/**
 * 占位契约刀 B：卡的高度天花板（2026-08-29）。
 *
 * 判据先验：封顶最容易封成"静默截断"—— 卡矮了、agent 不知道、用户点开才发现半篇
 * 没了。所以每条都成对：**高度真被封住** + **工具如实说被折叠了**（越界钳住但要说）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-cardcap-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { textBox } = await import('./sketch-layout.js');
const { CARD_MAX_H } = await import('./screen.js');

const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行，写满一整章的板书就是这么来的。`).join('\n');
const short = '一句话。';

describe('textBox 卡高封顶', () => {
  it('⭐ md：超长内容封到天花板，并带上真实高度', () => {
    const box = textBox(long, 'md', { md: true });
    expect(box.h).toBe(CARD_MAX_H);
    expect(box.capped).toBe(true);
    expect(box.fullH).toBeGreaterThan(CARD_MAX_H);
  });

  it('⭐ plain：同样封顶', () => {
    const box = textBox(long, 'md', { md: false });
    expect(box.h).toBe(CARD_MAX_H);
    expect(box.capped).toBe(true);
  });

  it('短内容一个字段都不多加（capped 只在真封顶时出现）', () => {
    const box = textBox(short, 'md', { md: true });
    expect(box.h).toBeLessThan(CARD_MAX_H);
    expect(box.capped).toBeUndefined();
    expect(box.fullH).toBeUndefined();
  });

  it('封顶不动宽度（宽是契约，高才是结果）', () => {
    const wide = textBox(long, 'md', { md: true, wUnits: 18 });
    expect(wide.w).toBe(18 * 24);
  });
});

describe('工具如实报折叠', () => {
  const pid = 'proj_cardcap_e2e';
  let write1;

  beforeAll(async () => {
    const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
    const { makeOpenSheetTool } = await import('../engine/mcp/tools/open-sheet.js');
    const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
    const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
    const { _resetSheetState } = await import('./sheet-state.js');
    await ensureProjectWorkspace(pid);
    _resetViewpoints(); _resetSheetState();
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    const ctx = { emit() {} };
    const sharedRoot = getSharedDir(pid);
    write1 = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'cap', ctx }).handler(args, {});
    await makeOpenSheetTool({ projectId: pid, sessionId: 'cap', ctx }).handler({}, {});
  });

  it('⭐ 写一整章 → 报文点名被折叠、给出真实高度、建议拆条或翻页', async () => {
    const r = await write1({ text: long });
    expect(r.isError).toBeUndefined();
    const txt = r.content[0].text;
    expect(txt).toMatch(/folded/);
    expect(txt).toMatch(new RegExp(`shows ${CARD_MAX_H}px`));
    expect(txt).toMatch(/Split it into several notes|fresh sheet/);
  });

  it('⭐ 落盘的座位高度也是封顶后的（占位系统看到的就是卡真实占的地方）', async () => {
    const { readBoard } = await import('../projects/board-store.js');
    const board = await readBoard(pid);
    const chalk = Object.entries(board.objects).find(([id]) => id.startsWith('notes/板书/'));
    expect(chalk).toBeTruthy();
    expect(chalk[1].h).toBe(CARD_MAX_H);
  });

  it('⭐ 反向：短板书不许报折叠（防止把提醒写成永远都说）', async () => {
    const r = await write1({ text: short });
    expect(r.content[0].text).not.toMatch(/folded/);
  });
});
