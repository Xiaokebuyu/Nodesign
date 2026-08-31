/**
 * 版面规划（2026-08-29 占位契约刀 E）。站主拍板：**agent 提前规划所有落位，再开始生成**。
 *
 * 判据先验：拒收最容易做成"半写"—— 报了错但文件已经落盘、座位已经占上。所以每条
 * 拒收都配一发「板上件数没变」。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-slot-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const pid = 'proj_slot_plan';
let open1; let write1; let readBoard;

beforeAll(async () => {
  const { makeOpenSheetTool } = await import('../engine/mcp/tools/open-sheet.js');
  const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
  const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
  const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
  const { _resetSheetState } = await import('./sheet-state.js');
  ({ readBoard } = await import('../projects/board-store.js'));
  await ensureProjectWorkspace(pid);
  _resetViewpoints(); _resetSheetState();
  setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
  const ctx = { emit() {} };
  const sharedRoot = getSharedDir(pid);
  open1 = (a = {}) => makeOpenSheetTool({ projectId: pid, sessionId: 'slot', ctx }).handler(a, {});
  write1 = (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'slot', ctx }).handler(a, {});
});

const countObjects = async () => Object.keys((await readBoard(pid)).objects || {}).length;

describe('open_sheet 的版面规划', () => {
  it('⭐ plan 落进纸里，返回报每块地的容量和整页覆盖率', async () => {
    const r = await open1({
      title: '第二章',
      plan: [
        { slot: 'main', at: { x: 0, y: 0 }, w: 432, h: 600, about: '正文' },
        { slot: 'aside', at: { x: 460, y: 0 }, w: 300, h: 300, about: '人物' },
      ],
    });
    expect(r.isError).toBeUndefined();
    const txt = r.content[0].text;
    expect(txt).toMatch(/Planned 2 slots covering \d+%/);
    expect(txt).toMatch(/main（正文）/);
    expect(txt).toMatch(/CJK chars/);
    const board = await readBoard(pid);
    expect(board.sheets.p1.slots.main).toMatchObject({ x: 0, y: 0, w: 432, h: 600, about: '正文' });
  });

  it('⭐ 没规划时点破浪费：一张横纸只写一栏会空掉大半', async () => {
    const r = await open1({ title: '没规划' });
    expect(r.content[0].text).toMatch(/No slots planned/);
    expect(r.content[0].text).toMatch(/columns side by side/);
  });
});

describe('write_on_board 的版位落位', () => {
  it('⭐ 写进 main → 落在那块地的左上，宽度由那块地决定', async () => {
    await open1({
      title: '写', name: 'w1',
      plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 432, h: 600 }],
    });
    const r = await write1({ slot: 'main', text: '第一段。' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/in slot "main"/);
    const board = await readBoard(pid);
    const sheet = board.sheets.w1;
    const entry = Object.entries(board.objects).find(([id]) => /第一段/.test(id))[1];
    expect(entry.x).toBe(sheet.x + 24 + 0);     // 版心 + slot.x
    expect(entry.w).toBe(432);                   // 宽度＝那块地的宽
  });

  it('⭐ 第二条堆在第一条下面（同一块地里往下排）', async () => {
    const r = await write1({ slot: 'main', text: '第二段。' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const first = Object.entries(board.objects).find(([id]) => /第一段/.test(id))[1];
    const second = Object.entries(board.objects).find(([id]) => /第二段/.test(id))[1];
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.h);
  });

  /**
   * ⚠️ 2026-08-31 改了这条的答案：装不下**不再拒收**，改成溢出暂存（内容照写、
   * 落暂存架、当场要它安置）。理由是代价——全库四分之一的工具失败是"装不下，
   * 一个字没写"，其中六分之一差的还不到一行。
   * 这条测试原来守的两件事仍然守着：**量纲报文**（差多少 px，两边同单位）和
   * **位置仍然没定**（座位出处是 shelf，架不是版面）。
   */
  it('⭐ 装不下 → 溢出暂存：内容照写、落架、报文仍报差多少', async () => {
    const before = await countObjects();
    const long = Array.from({ length: 60 }, (_, i) => `这是第 ${i} 行，用来把这块地撑爆。`).join('\n');
    const r = await write1({ slot: 'main', text: long });
    expect(r.isError).toBeUndefined();
    const txt = r.content[0].text;
    expect(txt).toMatch(/OVERFLOW/);
    expect(txt).toMatch(/parked on the shelf/);
    expect(txt).toMatch(/short by \d+px/);   // 08-30 刀⑥：两边同量纲，差多少直说
    expect(txt).toMatch(/replan/);
    // ⭐ 内容落盘了（这正是这一刀救的东西），但位置仍然没定
    expect(await countObjects()).toBe(before + 1);
    const b = await readBoard(pid);
    const shelved = Object.values(b.objects).filter(e => e.seat === 'shelf');
    expect(shelved.length).toBe(1);
  });

  it('⭐ slot 名不存在 → 报错并列出这张纸有哪些地', async () => {
    const before = await countObjects();
    const r = await write1({ slot: 'nope', text: '随便' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/has no slot "nope"/);
    expect(r.content[0].text).toMatch(/main/);
    expect(await countObjects()).toBe(before);
  });

  it('⭐ 反向：装得下的照写不误（防止把拒收写成永远拒）', async () => {
    const before = await countObjects();
    const r = await write1({ slot: 'main', text: '短短一句。' });
    expect(r.isError).toBeUndefined();
    expect(await countObjects()).toBe(before + 1);
  });
});
