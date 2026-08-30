/**
 * 一块卡的高度上限（2026-08-29 占位契约刀 B→E）。
 *
 * ⚠️ 范式换过一次：先做成"渲染层折叠 + 估算封顶"，站主否掉 ——「收起展开没必要，
 * 应当提示 agent 让她分块内容、重新布置」。上限的执行点因此从渲染层挪到**工具层**：
 * 写不下就拒收，什么都不落盘，把还剩多少报回去。折叠/裁切都是替它把问题藏起来，
 * 而它下一条还会照写不误。
 *
 * 判据成对：拒了 + 说清楚还剩多少 / 装得下的照写不误 / 拒收时板上件数没变。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-cardcap-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { textBox, capacityOf, DEFAULT_CHALK_W } = await import('./sketch-layout.js');
const { CARD_MAX_H } = await import('./screen.js');

const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行，写满一整章的板书就是这么来的。`).join('\n');
const short = '一句话。';

describe('textBox 报真实高度（不再封顶）', () => {
  it('⭐ 超长内容如实给出真高度 —— 封顶会让调用方以为装得下', () => {
    const box = textBox(long, 'md', { md: true });
    expect(box.h).toBeGreaterThan(CARD_MAX_H);
    expect(box.capped).toBeUndefined();
  });

  it('短内容照常', () => {
    expect(textBox(short, 'md', { md: true }).h).toBeLessThan(CARD_MAX_H);
  });

  it('宽度是契约（给了就用给的）', () => {
    expect(textBox(long, 'md', { md: true, wUnits: 18 }).w).toBe(18 * 24);
  });
});

describe('工具层拒收超长（没规划版面时）', () => {
  const pid = 'proj_cardcap_e2e';
  let write1; let readBoard;
  const countObjects = async () => Object.keys((await readBoard(pid)).objects || {}).length;

  beforeAll(async () => {
    const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
    const { makeOpenSheetTool } = await import('../engine/mcp/tools/open-sheet.js');
    const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
    const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
    const { _resetSheetState } = await import('./sheet-state.js');
    ({ readBoard } = await import('../projects/board-store.js'));
    await ensureProjectWorkspace(pid);
    _resetViewpoints(); _resetSheetState();
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    const ctx = { emit() {} };
    const sharedRoot = getSharedDir(pid);
    write1 = (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'cap', ctx }).handler(a, {});
    await makeOpenSheetTool({ projectId: pid, sessionId: 'cap', ctx }).handler({}, {});
  });

  it('⭐ 写一整章 → 拒收，报清楚一块卡能装多少、给出两条出路', async () => {
    const before = await countObjects();
    const r = await write1({ text: long });
    expect(r.isError).toBe(true);
    const txt = r.content[0].text;
    expect(txt).toMatch(/Too long for one card/);
    expect(txt).toMatch(new RegExp(`${CARD_MAX_H}px`));
    expect(txt).toMatch(/CJK chars/);
    expect(txt).toMatch(/chain:true/);          // 出路①：拆成几条串起来
    expect(txt).toMatch(/open_sheet\{plan:/);   // 出路②：先规划版面
    // ⭐ 什么都没写 —— 拒收不能是"半写"
    expect(await countObjects()).toBe(before);
  });

  it('⭐ 反向：短板书照写不误（防止把拒收写成永远拒）', async () => {
    const before = await countObjects();
    const r = await write1({ text: short });
    expect(r.isError).toBeUndefined();
    expect(await countObjects()).toBe(before + 1);
  });
});

/**
 * 给 agent 的字数量纲（刀 D）。
 * ⚠️ 这一组同时是**教义与代码的 parity**：prelude 里白纸黑字写着「默认板书宽
 * 432px ≈ 一行 26 个汉字」「一张纸竖着排 35 行上下」。公式一改那两句就成了谎话，
 * 而提示词不会报错 —— 所以把它们钉在这里。
 */
describe('capacityOf 字数量纲', () => {
  it('⭐ 默认板书宽（432px）一行 26 个汉字 —— prelude 里就是这么教的', () => {
    expect(capacityOf(DEFAULT_CHALK_W, 1000).perLine).toBe(26);
    expect(DEFAULT_CHALK_W).toBe(432);
  });

  it('⭐ 一张 2000x925 版心的纸竖着排 35 行 —— prelude 里就是这么教的', () => {
    expect(capacityOf(DEFAULT_CHALK_W, 925).lines).toBe(35);
  });

  it('拉丁字符按 0.62em 折算（跟 textBox 同一把尺）', () => {
    const c = capacityOf(DEFAULT_CHALK_W, 925);
    expect(c.latin).toBe(Math.round(c.cjk / 0.62));
  });

  it('一块卡的天花板约 14 行', () => {
    expect(capacityOf(DEFAULT_CHALK_W, CARD_MAX_H).lines).toBe(14);
  });

  it('地方不够就是 0 行，不给负数', () => {
    expect(capacityOf(DEFAULT_CHALK_W, 0).lines).toBe(0);
    expect(capacityOf(0, 0).perLine).toBeGreaterThanOrEqual(1);
  });
});
