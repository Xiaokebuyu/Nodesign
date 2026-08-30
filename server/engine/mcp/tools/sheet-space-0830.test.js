/**
 * 屏幕空间六刀的集成断言（2026-08-30：flow / h 占位 / replan / 翻页裁纸 /
 * 铺纸点名占地者 / 拒收报文量纲）。
 *
 * 每条都是 proj_mtfpehm3 真会话里挂过或看不清的那一发的回归钉。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-space0830-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeOpenSheetTool } = await import('./open-sheet.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { makeEditBoardTool } = await import('./edit-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { _resetSheetState } = await import('../../../lib/sheet-state.js');

const ctx = { emit() {} };
const mk = async (pid) => {
  await ensureProjectWorkspace(pid);
  const sharedRoot = getSharedDir(pid);
  return {
    open: (a = {}) => makeOpenSheetTool({ projectId: pid, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    write: (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    edit: (a) => makeEditBoardTool({ projectId: pid, sharedRoot, sessionId: `${pid}-s`, ctx }).handler(a, {}),
  };
};
const LONG = Array.from({ length: 26 }, (_, i) => `第 ${i + 1} 段：这一段把一件事讲完整，句子成型，前后各自独立，段落之间留着空行等 flow 下刀，写满一整块版位再往下走。`).join('\n\n');

beforeAll(() => { _resetViewpoints(); _resetSheetState(); });

describe('刀⑦ flow：长文拆链', () => {
  it('⭐ 版位装不下一整篇 → 拆成多条链好、装到哪儿是哪儿、剩余原样退回并教续写', async () => {
    const t = await mk('proj_sp_flow');
    setViewpoint('proj_sp_flow', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '流', plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 600, h: 850, about: '正文' }] });
    const r = await t.write({ slot: 'main', flow: true, tag: 'ch', text: LONG });
    expect(r.isError).toBeUndefined();
    const txt = r.content[0].text;
    expect(txt).toMatch(/Flowed into \d+ chained notes/);
    expect(txt).toMatch(/did NOT fit/);                       // 850px 装不下 26 段
    expect(txt).toMatch(/flow:true, chain:true/);             // 教了怎么续
    expect(txt).toMatch(/Slot "main" now has/);               // 余量随手报
    const b = await readBoard('proj_sp_flow');
    const notes = Object.keys(b.objects).filter((k) => k.startsWith('notes/板书/'));
    expect(notes.length).toBeGreaterThan(1);
    // 链真的接上了：flow 线一条不少
    const flows = Object.values(b.bindings).filter((x) => x?.type === 'flow');
    expect(flows.length).toBe(notes.length - 1);
  });

  it('flow 全装下时没有退回段；不带 slot 也能在纸上流', async () => {
    const t = await mk('proj_sp_flow2');
    setViewpoint('proj_sp_flow2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '白纸' });
    const r = await t.write({ flow: true, tag: 'ch', text: LONG.split('\n\n').slice(0, 8).join('\n\n') });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/did NOT fit/);
  });
});

describe('刀⑧ h 占位 + replan', () => {
  it('h 预约：内容比框矮时框保留，返回说清', async () => {
    const t = await mk('proj_sp_hbox');
    setViewpoint('proj_sp_hbox', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '框' });
    const r = await t.write({ at: { x: 0, y: 0 }, h: 360, text: '短短一句。' });
    expect(r.content[0].text).toMatch(/reserved at 360px/);
    const b = await readBoard('proj_sp_hbox');
    const note = Object.entries(b.objects).find(([k]) => k.startsWith('notes/板书/'));
    expect(note[1].h).toBe(360);
  });

  it('⭐ replan 给已有的纸补版位（按名合并，旧版位保留），补完立刻能写', async () => {
    const t = await mk('proj_sp_replan');
    setViewpoint('proj_sp_replan', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '重规划', plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 600, h: 800, about: '正文' }] });
    const r = await t.edit({ ops: [{ op: 'replan', plan: [{ slot: 'aside', at: { x: 640, y: 0 }, w: 360, h: 560 }] }] });
    expect(r.content[0].text).toMatch(/replan/);
    const b = await readBoard('proj_sp_replan');
    const slots = Object.values(b.sheets)[0].slots;
    expect(Object.keys(slots).sort()).toEqual(['aside', 'main']);   // 旧的保留
    expect(slots.aside.h).toBe(560);
    const w = await t.write({ slot: 'aside', text: '状态表进新家。' });
    expect(w.isError).toBeUndefined();
  });
});

describe('刀② 翻页裁纸', () => {
  it('⭐ 开下一张时上一张裁到内容底：纸间空白 = 真实的 48px 沟，不是几百像素', async () => {
    const t = await mk('proj_sp_trim');
    setViewpoint('proj_sp_trim', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '第一页', name: 'a1' });
    await t.write({ at: { x: 0, y: 0 }, text: '只有一小条。' });
    const r2 = await t.open({ title: '第二页', name: 'a2' });
    expect(r2.content[0].text).toMatch(/trimmed to its content/);
    const b = await readBoard('proj_sp_trim');
    expect(b.sheets.a1.h).toBeLessThan(500);                          // 一屏高被裁下来了
    expect(b.sheets.a2.y).toBe(b.sheets.a1.y + b.sheets.a1.h + 48);   // 紧贴 48 沟
  });

  it('上一张写得满就不裁（裁的是余白不是内容）', async () => {
    const t = await mk('proj_sp_trim2');
    setViewpoint('proj_sp_trim2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ name: 'b1' });
    const b0 = await readBoard('proj_sp_trim2');
    const tall = Math.round(b0.sheets.b1.h - 60);
    await patchBoard('proj_sp_trim2', { objects: { 'notes/板书/x.md': { x: b0.sheets.b1.x + 24, y: b0.sheets.b1.y + 24, w: 400, h: tall } } });
    await t.open({ name: 'b2' });
    const b = await readBoard('proj_sp_trim2');
    expect(b.sheets.b1.h).toBe(b0.sheets.b1.h);
  });
});

describe('刀③ 铺纸点名占地者', () => {
  it('⭐ 纸铺在文件夹卡上 → 点名它、报它占了哪个版位、给三条出路（真案里这里是沉默的）', async () => {
    const pid = 'proj_sp_occ';
    const t = await mk(pid);
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await patchBoard(pid, { zones: { 记忆: { x: 300, y: 300 } } });
    const r = await t.open({ title: '压上了', plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 700, h: 800, about: '正文' }] });
    const txt = r.content[0].text;
    expect(txt).toMatch(/ALREADY LIVE/);
    expect(txt).toMatch(/📁 记忆/);
    expect(txt).toMatch(/sits in your slot "main"/);
    expect(txt).toMatch(/replan/);
  });
});

describe('刀⑥ 拒收报文量纲', () => {
  it('版位拒收：两边都是 px，差多少直说，教 flow', async () => {
    const t = await mk('proj_sp_msg');
    setViewpoint('proj_sp_msg', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '小格', plan: [{ slot: 'tiny', at: { x: 0, y: 0 }, w: 432, h: 60, about: '塞不下' }] });
    const r = await t.write({ slot: 'tiny', text: Array.from({ length: 6 }, () => '这一条明显超过六十像素的高度，句子还在继续。').join('\n') });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/short by \d+px/);
    expect(r.content[0].text).toMatch(/Free: \d+px/);
    expect(r.content[0].text).toMatch(/flow:true/);
  });
});

describe('空位竖排糖（2026-08-30 用户拍板「自己定几个空位分段填」）', () => {
  it('⭐ plan 省掉 at → 依次竖排（y 累加归机器）；below 点名接在谁底下', async () => {
    const t = await mk('proj_sp_stack');
    setViewpoint('proj_sp_stack', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '分段', plan: [
      { slot: 's1', w: 600, h: 340 },
      { slot: 's2', w: 600, h: 280 },                    // 没 at：s1 正下方
      { slot: 'aside', below: 's1', at: { x: 640 }, w: 360, h: 400 },  // 点名接 s1，x 自己给
    ] });
    const b = await readBoard('proj_sp_stack');
    const sl = Object.values(b.sheets)[0].slots;
    expect(sl.s1).toMatchObject({ x: 0, y: 0 });
    expect(sl.s2).toMatchObject({ x: 0, y: 340 + 24 });
    expect(sl.aside).toMatchObject({ x: 640, y: 340 + 24 });
    // 分段填：三段各进各的空位，互不连坐
    for (const s of ['s1', 's2']) {
      const w = await t.write({ slot: s, tag: 'ch', chain: true, text: `${s} 的那一段。` });
      expect(w.isError).toBeUndefined();
    }
  });

  it('replan 的 below 能引用纸上已有的版位（写到一半补一块地）', async () => {
    const t = await mk('proj_sp_stack2');
    setViewpoint('proj_sp_stack2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '补地', plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 600, h: 300 }] });
    await t.edit({ ops: [{ op: 'replan', plan: [{ slot: 'more', below: 'main', w: 600, h: 240 }] }] });
    const b = await readBoard('proj_sp_stack2');
    expect(Object.values(b.sheets)[0].slots.more).toMatchObject({ x: 0, y: 324 });
  });
});
