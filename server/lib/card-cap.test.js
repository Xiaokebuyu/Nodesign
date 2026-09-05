/**
 * 一块卡的高度上限（2026-08-29 占位契约刀 B→E；2026-09-05 意图层改口径）。
 *
 * 08-29 的口径是工具层拒收。09-05 板书定位收窄成解释以后，硬拒是拿一整轮换一个
 * 教训：内容照写、卡高封顶、超出的折在卡里，返回里如实报并教「一条板书说一件事，
 * 真内容进产物」。
 *
 * 判据成对：封顶了 + 如实报 / 短的照写不提 / 件数 +1。
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

describe('工具层封顶折叠（2026-09-05：不再拒收，板书说一件事这句话在返回里教）', () => {
  const pid = 'proj_cardcap_e2e';
  let write1; let readBoard;
  const countObjects = async () => Object.keys((await readBoard(pid)).objects || {}).length;

  beforeAll(async () => {
    const { makeWriteOnBoardTool } = await import('../engine/mcp/tools/write-on-board.js');
    const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');
    const { setViewpoint, _resetViewpoints } = await import('../projects/viewpoint-store.js');
    ({ readBoard } = await import('../projects/board-store.js'));
    await ensureProjectWorkspace(pid);
    _resetViewpoints();
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    const ctx = { emit() {} };
    const sharedRoot = getSharedDir(pid);
    write1 = (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 'cap', ctx }).handler(a, {});
  });

  it('⭐ 写一整章 → 照写，卡高封顶在 CARD_MAX_H，返回如实报折叠并教「一条板书说一件事」', async () => {
    const before = await countObjects();
    const r = await write1({ text: long });
    expect(r.isError).toBeUndefined();
    const txt = r.content[0].text;
    expect(txt).toMatch(/Long for one card/);
    expect(txt).toMatch(/folded/);
    expect(txt).toMatch(/artifact/);
    expect(await countObjects()).toBe(before + 1);
    const board = await readBoard(pid);
    const id = Object.keys(board.objects).filter(i => i.startsWith('notes/板书/')).sort().pop();
    expect(board.objects[id].h).toBe(CARD_MAX_H);
  });

  it('⭐ 反向：短板书照写、不提折叠', async () => {
    const before = await countObjects();
    const r = await write1({ text: short });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/folded/);
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
