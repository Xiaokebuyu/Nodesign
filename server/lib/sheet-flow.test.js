/**
 * 机器排版（2026-09-01 刀 2）—— 版位退役之后纸内怎么排。
 *
 * 站主的判词：「有了叠放逻辑之后我们也许根本不需要思考怎么在纸张内部摆放文本块
 * （slot），文本的阅读本来就是从左到右从上到下，模型在纸张中只需要输入内容，
 * 然后由机械层自动排版切层就行了」。
 *
 * 这一份钉的是那句话的三个执行点，每条都配一个对照（反着的输入必须给出不同结果，
 * 否则这条断言证明不了任何事）：
 *   ① 不给位置就按栏排，栏满换栏
 *   ② 整页满了**机器自己翻到这一摞的下一页**（08-29「绝不替你翻页」当天翻案）
 *   ③ 一张卡装不下的长文机器自动拆段（不再整条拒收）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-flow-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const pid = 'proj_sheet_flow';
let open1; let write1; let readBoard; let sheetColumns;

beforeAll(async () => {
  const { makeOpenSheetTool } = await import('../engine/mcp/tools/open-sheet.js');
  const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
  const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
  const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
  const { _resetSheetState } = await import('./sheet-state.js');
  ({ readBoard } = await import('../projects/board-store.js'));
  ({ sheetColumns } = await import('./board-sheets.js'));
  await ensureProjectWorkspace(pid);
  _resetViewpoints(); _resetSheetState();
  setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
  const ctx = { emit() {} };
  const sharedRoot = getSharedDir(pid);
  open1 = (a = {}) => makeOpenSheetTool({ projectId: pid, sessionId: 'flow', ctx }).handler(a, {});
  write1 = (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'flow', ctx }).handler(a, {});
});

const txt = (r) => r.content.map((c) => c.text).join('\n');
const chalkOf = async () => Object.entries((await readBoard(pid)).objects || {})
  .filter(([id]) => id.startsWith('notes/板书/'));

describe('① 纸内按栏排（不给 at，机器说了算）', () => {
  it('⭐ open_sheet 报的是栏，不是版位 —— 它连 plan 这个参数都没有了', async () => {
    const r = await open1({ title: '第一章', name: 'ch1' });
    expect(r.isError).toBeUndefined();
    expect(txt(r)).toMatch(/Layout is the machine's job: \d+ column\(s\) of \d+px/);
    expect(txt(r)).toMatch(/THE PAGE TURNS BY ITSELF/);
    // 版位那套报文一个字都不该再出现
    expect(txt(r)).not.toMatch(/Planned \d+ slots/);
    expect(txt(r)).not.toMatch(/slot/);
  });

  it('⭐ 一条条写下去：先填满第一栏，再跳到第二栏顶上', async () => {
    const board0 = await readBoard(pid);
    const cols = sheetColumns({ id: 'ch1', ...board0.sheets.ch1 });
    expect(cols.n).toBeGreaterThan(1);          // 前提：这张纸真有第二栏
    const long = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行内容。`).join('\n');
    const xs = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await write1({ text: `${i}\n${long}` });
      expect(r.isError, txt(r)).toBeUndefined();
    }
    for (const [, e] of await chalkOf()) xs.push(e.x);
    const uniq = [...new Set(xs)].sort((a, b) => a - b);
    expect(uniq.length, '应该真的换过栏').toBeGreaterThan(1);
    // 落点全在栏格上（不是贴着上一件的右边随便找的空地）
    const grid = Array.from({ length: cols.n }, (_, i) => Math.round(cols.inner.x + i * (cols.colW + cols.gap)));
    for (const x of uniq) expect(grid, `x=${x} 不在栏格 ${grid} 上`).toContain(x);
  });
});

describe('② 整页满了机器自己翻页', () => {
  it('⭐⭐ 一直写下去 → 板上多出一页，且是**同一摞**的下一页，不是往下铺的新纸', async () => {
    const before = await readBoard(pid);
    const nSheets = Object.keys(before.sheets).length;
    const long = Array.from({ length: 12 }, (_, i) => `续写 ${i}。`).join('\n');
    let turnedMsg = null;
    for (let i = 0; i < 30 && !turnedMsg; i += 1) {
      const r = await write1({ text: `补 ${i}\n${long}` });
      expect(r.isError, txt(r)).toBeUndefined();
      if (/turned to page/.test(txt(r))) turnedMsg = txt(r);
    }
    expect(turnedMsg, '写满一整页之后机器应当翻页并如实报').toBeTruthy();
    const after = await readBoard(pid);
    expect(Object.keys(after.sheets).length).toBe(nSheets + 1);
    const fresh = Object.entries(after.sheets).find(([id]) => !before.sheets[id]);
    // 同一摞 = 同一块地（叠上去），不是 08-29 那种往下铺一张
    expect(fresh[1].stack).toBe('ch1');
    expect(fresh[1].x).toBe(before.sheets.ch1.x);
    expect(fresh[1].y).toBe(before.sheets.ch1.y);
    // 栏格跟着这一摞的头一页走，翻页版心不跳
    expect(fresh[1].colW).toBe(before.sheets.ch1.colW);
  });

  it('⭐ 翻过去的那一页认领的是新页 —— 认错页的话前端翻页会把它藏起来', async () => {
    const board = await readBoard(pid);
    const pages = new Set(Object.entries(board.objects || {})
      .filter(([id]) => id.startsWith('notes/板书/'))
      .map(([, e]) => e.sheet));
    expect(pages.size).toBeGreaterThan(1);
    for (const p of pages) expect(board.sheets[p], `认领了一张不存在的纸 ${p}`).toBeTruthy();
  });
});

describe('③ 一张卡装不下的长文，机器自动拆段', () => {
  it('⭐⭐ 不传 flow、写一整章 → 拆成一串链好的板书，不再整条拒收', async () => {
    const chapter = Array.from({ length: 30 }, (_, i) =>
      `第 ${i + 1} 段。这一段写得足够长，好让整篇内容远远超过一张卡片装得下的高度。`).join('\n\n');
    const n0 = (await chalkOf()).length;
    const r = await write1({ text: chapter, tag: 'zhang' });
    expect(r.isError, txt(r)).toBeUndefined();
    expect(txt(r)).toMatch(/The machine split this into \d+ chained notes/);
    const n1 = (await chalkOf()).length;
    expect(n1 - n0, '应当落了好几条，而不是一条也没落').toBeGreaterThan(1);
    // 对照：短内容照旧一条（拆分不是无条件发生的）
    const r2 = await write1({ text: '就一句话。' });
    expect(txt(r2)).not.toMatch(/split this into/);
    expect((await chalkOf()).length - n1).toBe(1);
  });

  it('⭐ 拆出来的段之间有 flow 线（拆开不等于散开）', async () => {
    const board = await readBoard(pid);
    const flows = Object.values(board.bindings || {}).filter((b) => b.type === 'flow' && b.tag === 'zhang');
    expect(flows.length).toBeGreaterThan(0);
  });
});

describe('④ 退役的东西真的没了', () => {
  it('⛔ slot 不再是 write_on_board 的参数（传了会被 zod 剥掉，探针会点名）', async () => {
    const { WRITE_SCHEMA } = await import('../engine/mcp/tools/write-on-board-schema.js');
    expect(WRITE_SCHEMA.slot).toBeUndefined();
  });
  it('⛔ open_sheet 没有 plan / scope，多了 near / order', async () => {
    const { makeOpenSheetTool } = await import('../engine/mcp/tools/open-sheet.js');
    const t = makeOpenSheetTool({ projectId: pid, sessionId: 'x', ctx: { emit() {} } });
    const keys = Object.keys(t.inputSchema ?? t.schema ?? {});
    expect(keys).not.toContain('plan');
    expect(keys).not.toContain('scope');
    expect(keys).toContain('near');
    expect(keys).toContain('order');
  });
  it('⛔ edit_board 没有 replan 这个 op 了', async () => {
    const src = await fs.readFile(new URL('../engine/mcp/tools/edit-board-schema.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/literal\('replan'\)/);
  });
});
