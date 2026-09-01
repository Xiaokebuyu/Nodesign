/**
 * 溢出暂存（2026-08-31 站主拍板）：版位/纸装不下时**内容照写、落暂存架、当场
 * 要求安置**，不再整条拒收。
 *
 * 为什么改：全库 547 次自动记录的工具失败里 182 次是 write_on_board，其中
 * **136 次是「装不下，一个字没写」——占全系统工具失败的四分之一**；116 次版位
 * 拒收里 19 次差的不到一行（差 1px / 2px / 9px / 11px 的都有）。
 *
 * 没被跨过的那条线：位置**仍然没定**。架不是版面，状态块每回合继续点名，
 * 只是不再拿"整条重写"当收费站。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-overflow0831-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeOpenSheetTool } = await import('./open-sheet.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { readBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { _resetSheetState } = await import('../../../lib/sheet-state.js');
const { shelfItems } = await import('../../../lib/board-shelf.js');
const { SHELF_W } = await import('../../../lib/board-shelf.js');

const ctx = { emit() {} };
const mk = async (pid) => {
  await ensureProjectWorkspace(pid);
  const sharedRoot = getSharedDir(pid);
  return {
    open: (a = {}) => makeOpenSheetTool({ projectId: pid, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    write: (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: `${pid}-s`, ctx }).handler(a, {}),
  };
};
/** 一段一定装不进小块的正文（26 行上下） */
const BIG = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行：这一行写满，让它稳稳地占掉一行的高度，好把小块撑爆。`).join('\n');

beforeAll(() => { _resetViewpoints(); _resetSheetState(); });

describe('版位装不下 → 溢出暂存', () => {
  it('⭐ 内容照写、落到架上、报文点名要它安置（不再 isError）', async () => {
    const t = await mk('proj_ovf_slot');
    setViewpoint('proj_ovf_slot', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '窄', plan: [{ slot: 'tiny', at: { x: 0, y: 0 }, w: 432, h: 80, about: '故意很矮' }] });

    const r = await t.write({ slot: 'tiny', text: BIG });
    // ① 不再是错误
    expect(r.isError, '装不下不该再整条拒收').toBeUndefined();
    const txt = r.content[0].text;
    // ② 内容真的落盘了
    const b = await readBoard('proj_ovf_slot');
    const notes = Object.keys(b.objects).filter(k => k.startsWith('notes/板书/'));
    expect(notes.length, '内容必须写下来 —— 这正是这一刀要救的东西').toBe(1);
    // ③ 座位出处是 shelf，且在根层（架是根层的东西）
    const e = b.objects[notes[0]];
    expect(e.seat).toBe('shelf');
    expect(e.zone === '' || e.zone === undefined).toBe(true);
    // ④ 每回合的点名判据看得见它
    expect(shelfItems(b)).toEqual(notes);
    // ⑤ 报文说清了三件事：溢出了 / 为什么 / 现在立刻怎么安置
    expect(txt).toMatch(/OVERFLOW/);
    expect(txt).toMatch(/parked on the shelf/);
    expect(txt).toMatch(/short by/);          // 为什么（原拒收报文的第一行）
    expect(txt).toMatch(/replan/);            // 怎么办①
    expect(txt).toMatch(/op:"move"/);         // 怎么办②
    expect(txt).toMatch(/open_sheet/);        // 怎么办③
  });

  it('⭐ 差 1px 也走同一条路（不开小溢出的特例 —— 规则只有一条才好预测）', async () => {
    const t = await mk('proj_ovf_1px');
    setViewpoint('proj_ovf_1px', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    // 先量出一条的真实高度，再把版位切得刚好差一点
    await t.open({ title: '刚好', plan: [{ slot: 'a', at: { x: 0, y: 0 }, w: 432, h: 800 }] });
    const one = await t.write({ slot: 'a', text: '一行字。' });
    const b1 = await readBoard('proj_ovf_1px');
    const h = Object.values(b1.objects)[0].h;

    const t2 = await mk('proj_ovf_1px2');
    setViewpoint('proj_ovf_1px2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t2.open({ title: '差一点', plan: [{ slot: 'a', at: { x: 0, y: 0 }, w: 432, h: h - 1 }] });
    const r = await t2.write({ slot: 'a', text: '一行字。' });
    expect(one.isError).toBeUndefined();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/OVERFLOW/);
    const b2 = await readBoard('proj_ovf_1px2');
    expect(Object.values(b2.objects)[0].seat).toBe('shelf');
  });

  it('装得下的照旧落进版位，seat 是 agent，报文里没有 OVERFLOW', async () => {
    const t = await mk('proj_ovf_ok');
    setViewpoint('proj_ovf_ok', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '够用', plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 600, h: 800 }] });
    const r = await t.write({ slot: 'main', text: '短短一条。' });
    expect(r.content[0].text).not.toMatch(/OVERFLOW/);
    const b = await readBoard('proj_ovf_ok');
    expect(Object.values(b.objects)[0].seat).toBe('agent');
    expect(shelfItems(b)).toEqual([]);
  });
});

describe('架的原点与折列', () => {
  it('溢出件码进架带（纸群左侧），不落在纸上', async () => {
    const t = await mk('proj_ovf_where');
    setViewpoint('proj_ovf_where', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    const sh = await t.open({ title: '窄', plan: [{ slot: 'tiny', at: { x: 0, y: 0 }, w: 432, h: 80 }] });
    expect(sh.isError).toBeUndefined();
    await t.write({ slot: 'tiny', text: BIG });
    const b = await readBoard('proj_ovf_where');
    const sheet = Object.values(b.sheets)[0];
    const e = Object.values(b.objects)[0];
    expect(b.shelf, '架的原点要落盘').toBeTruthy();
    // 架整条在纸的左边：架带右缘 ≤ 纸左缘
    expect(b.shelf.x + SHELF_W).toBeLessThanOrEqual(sheet.x);
    expect(e.x).toBe(b.shelf.x);
  });

  /**
   * ⭐ 这一条 2026-09-01 **换了契约**（站主拍板「暂存架我们干脆也就改成栈吧」）。
   *
   * 08-31 折列治的是柱子：架原来是一根不封口的竖列，真案 proj_mtg61or1 26 件
   * 码到 8322px、前端画出来是个 1:41 的虚线框横穿四张纸。折列把它封进一屏高，
   * 满了往左折。但架仍然按件数往横里长，而纸这一批也改成横着排（摞与摞左右
   * 相邻）—— 两边迟早还要抢地方。
   *
   * 一摞把这条账整个结掉：架只占一个位置，所有货叠在原点，一次显示最上面那件。
   * 所以现在要钉的**恰好是当初要防的形状**（全挤在一处），因为"挤"这件事已经
   * 由渲染层只画一件来处理了。
   */
  it('⭐ 连着溢出一堆：全部叠在架位上，架不按件数长', async () => {
    const t = await mk('proj_ovf_many');
    setViewpoint('proj_ovf_many', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '窄', plan: [{ slot: 'tiny', at: { x: 0, y: 0 }, w: 432, h: 80 }] });
    for (let i = 0; i < 10; i += 1) await t.write({ slot: 'tiny', text: `${BIG}\n第 ${i} 条。` });
    const b = await readBoard('proj_ovf_many');
    const shelved = Object.values(b.objects).filter(e => e.seat === 'shelf');
    expect(shelved.length).toBe(10);
    const xs = new Set(shelved.map(e => e.x));
    const ys = new Set(shelved.map(e => e.y));
    expect([xs.size, ys.size], '一摞：10 条落点必须完全重合').toEqual([1, 1]);
    expect({ x: [...xs][0], y: [...ys][0] }).toEqual({ x: b.shelf.x, y: b.shelf.y });
    const span = Math.max(...shelved.map(e => e.y + (e.h || 0))) - Math.min(...shelved.map(e => e.y));
    expect(span, '架的竖向跨度要封在一屏量级').toBeLessThan(1400);
  });
});

/**
 * 纸缝报在决策点上（2026-08-31，agent 自己报的 iss_mthb9nef「纸缝对用户可见、
 * 对 agent 不可见」）。真案 proj_mth8wd7k：一章 12 张纸，覆盖率平均 27%，
 * 纸内尾部空白 1871px + 纸缝 576px = 板高的 23%。
 */
describe('open_sheet 报纸缝与翻页代价', () => {
  it('⭐ 上一张还剩一大截就翻页 → 报剩多少 + 报纸缝', async () => {
    const t = await mk('proj_gap_warn');
    setViewpoint('proj_gap_warn', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '第一张' });
    await t.write({ text: '就写一条短的。' });          // 纸几乎全空
    // 2026-09-01：纸缝只有「往下铺」那一档才有（叠起来的页不占竖向空间，
    // 没有缝可报）。缺省已经翻案成叠 —— 这条钉的是竖排那一档，所以点名 next。
    const r = await t.open({ title: '第二张', where: 'next' });
    const txt = r.content[0].text;
    expect(txt).toMatch(/Gap above: \d+px/);
    expect(txt).toMatch(/still had ~\d+px free/);
    expect(txt).toMatch(/not for every beat/);
  });

  it('⭐ 叠一页也报「上一页还剩多少」（没有纸缝，但利用率那笔账照算）', async () => {
    const t = await mk('proj_gap_stack');
    setViewpoint('proj_gap_stack', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '第一页' });
    await t.write({ text: '就写一条短的。' });
    const txt = (await t.open({ title: '第二页' })).content[0].text;
    expect(txt).toMatch(/still had ~\d+px free/);
    expect(txt, '叠起来的页之间没有缝').not.toMatch(/Gap above/);
  });

  it('第一张纸没有"上一张"，不报纸缝', async () => {
    const t = await mk('proj_gap_first');
    setViewpoint('proj_gap_first', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    const r = await t.open({ title: '开工' });
    expect(r.content[0].text).not.toMatch(/Gap above/);
  });
});
