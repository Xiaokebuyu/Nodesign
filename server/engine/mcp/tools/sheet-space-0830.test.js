/**
 * 屏幕空间六刀的集成断言（2026-08-30：flow / h 占位 / 翻页裁纸 /
 * 铺纸点名占地者 / 报文量纲）。
 *
 * 每条都是 proj_mtfpehm3 真会话里挂过或看不清的那一发的回归钉。
 *
 * ⛔ 2026-09-01 刀 2：版位退役，这一份里挂在版位上的六条一并撤了（replan 两条、
 * 竖排糖三条、版位报文一条）。它们守的东西没有丢，只是换了执行点 ——
 * 「装不下要如实报」现在守在纸和栏上（server/lib/sheet-flow.test.js）。
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
  it('⭐ 一整篇长文 → 拆成多条链好的板书，装满一页就翻下一页（2026-09-01 起不再退回）', async () => {
    const t = await mk('proj_sp_flow');
    setViewpoint('proj_sp_flow', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '流' });
    const r = await t.write({ flow: true, tag: 'ch', text: LONG });
    expect(r.isError).toBeUndefined();
    const txt = r.content[0].text;
    expect(txt).toMatch(/The machine split this into \d+ chained notes/);
    const b = await readBoard('proj_sp_flow');
    const notes = Object.keys(b.objects).filter((k) => k.startsWith('notes/板书/'));
    expect(notes.length).toBeGreaterThan(1);
    // 链真的接上了：flow 线一条不少
    const flows = Object.values(b.bindings).filter((x) => x?.type === 'flow');
    expect(flows.length).toBe(notes.length - 1);
    // ⭐ 26 段全落了盘 —— 旧范式在这里会退回一部分（"did NOT fit"），现在没有退回
    expect(txt).not.toMatch(/did NOT fit/);
  });

  it('短内容用不上 flow（拆分不是无条件发生的）', async () => {
    const t = await mk('proj_sp_flow2');
    setViewpoint('proj_sp_flow2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '白纸' });
    const r = await t.write({ flow: true, tag: 'ch', text: '就一句话，拆不出第二块。' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/split this into/);
  });
});

describe('刀⑧ h 占位', () => {
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
});

describe('刀② 翻页裁纸', () => {
  it('⭐ 开下一张时上一张裁到内容底：纸间空白 = 真实的 48px 沟，不是几百像素', async () => {
    const t = await mk('proj_sp_trim');
    setViewpoint('proj_sp_trim', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '第一页', name: 'a1' });
    await t.write({ at: { x: 0, y: 0 }, text: '只有一小条。' });
    // 裁纸只发生在「往下铺」那一档（叠起来的页不留竖向余白，没什么可裁）
    const r2 = await t.open({ title: '第二页', name: 'a2', where: 'next' });
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
    const r = await t.open({ title: '压上了' });
    const txt = r.content[0].text;
    expect(txt).toMatch(/ALREADY LIVE/);
    expect(txt).toMatch(/📁 记忆/);
    // 出路也要说清（真案里这里整段是沉默的）
    expect(txt).toMatch(/edit_board move/);
  });
});

// ⚠️ 2026-08-31：处置从"拒收"改成"溢出暂存"，但**报文的量纲纪律原样保留** ——
// 这一组守的是"差多少直说、两边同单位"，跟放不放行无关。
describe('刀⑥ 装不下的报文量纲', () => {
  it('⭐ 比一整页还大的东西：如实报这一页有几栏几行，并教 flow', async () => {
    const t = await mk('proj_sp_msg');
    setViewpoint('proj_sp_msg', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    // 小纸（贴产物用的那种）：一整页也装不下一张 640 宽的卡
    await t.open({ title: '小纸', w: 480, h: 300 });
    const { makeSheetPlacer } = await import('./write-on-board-place.js');
    const { describeSheetFull } = makeSheetPlacer({ projectId: 'proj_sp_msg', sessionId: 'x', by: 'agent' });
    const b = await readBoard('proj_sp_msg');
    const msg = describeSheetFull(b, Object.keys(b.sheets)[0]);
    expect(msg).toMatch(/bigger than a whole sheet/);
    expect(msg).toMatch(/column\(s\) of \d+px/);
    expect(msg).toMatch(/~\d+ lines each/);
    expect(msg).toMatch(/flow:true/);
  });
});

describe('利用率两刀（2026-08-30 sonnet「每拍一张纸」真案）', () => {
  it('⭐ 写完随手报这一页每栏还剩多少（照着它判断，别凭感觉）', async () => {
    const t = await mk('proj_sp_reuse');
    setViewpoint('proj_sp_reuse', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '复用' });
    const w = await t.write({ tag: 'ch', text: '三行左右的一段话。\n再来一行。\n第三行。' });
    expect(w.isError).toBeUndefined();
    expect(w.content[0].text).toMatch(/now has \d+ column\(s\); the roomiest has ~\d+ lines/);
    expect(w.content[0].text).toMatch(/turns the page for you/);
  });

  it('⭐ 一页还剩大半就自己翻 → 点名「不用你翻」（只提醒不拦）', async () => {
    const t = await mk('proj_sp_waste');
    setViewpoint('proj_sp_waste', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '第一拍' });
    await t.write({ text: '短短一拍。' });
    const r = await t.open({ title: '第二拍', where: 'next' });
    expect(r.isError).toBeUndefined();                          // 不拦
    expect(r.content[0].text).toMatch(/still had ~\d+px free/);
    expect(r.content[0].text).toMatch(/You do not need to turn pages/);
    // 对照：上一页真写满了就不该说这句
    const t2 = await mk('proj_sp_waste2');
    setViewpoint('proj_sp_waste2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t2.open({ title: '满页', name: 'f1' });
    const b0 = await readBoard('proj_sp_waste2');
    await patchBoard('proj_sp_waste2', { objects: { 'notes/板书/full.md': {
      x: b0.sheets.f1.x + 24, y: b0.sheets.f1.y + 24, w: 400, h: b0.sheets.f1.h - 80,
    } } });
    const r2 = await t2.open({ title: '下一页' });
    expect(r2.content[0].text).not.toMatch(/You do not need to turn pages/);
  });
});

describe('状态表堵写口（2026-08-30 glm \\r 字面量真案）', () => {
  it('⭐ set_text 把状态表改成解析不出的正文 → 大声拒、盘上原文原样', async () => {
    const t = await mk('proj_sp_stguard');
    setViewpoint('proj_sp_stguard', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '守卫' });
    const w = await t.write({ tag: '状态表', text: '状态表\n\n| 键 | 值 |\n| --- | --- |\n| 好感度 | 3 |' });
    expect(w.isError).toBeUndefined();
    const b = await readBoard('proj_sp_stguard');
    const [id] = Object.entries(b.objects).find(([k]) => k.startsWith('notes/板书/'));
    const r = await t.edit({ ops: [{ op: 'set_text', id, text: '状态表\r\rn| 键 | 值 |\r\rn| --- | --- |\r\rn| 好感度 | 4 |' }] });
    expect(r.content[0].text).toMatch(/写坏|表没了|状态表/);
    const { readStateVars } = await import('../../../lib/state-table.js');
    const live = await readStateVars((await import('../../../projects/workspace.js')).getSharedDir('proj_sp_stguard'));
    expect(live.state).toBe('ok');                                 // 表还活着
    expect(live.rows.find((x) => x.key === '好感度').value).toBe('3');
  });

  it('创建口同样设防：write_on_board 挂状态表 tag 但正文没有表 → 拒收不落盘', async () => {
    const t = await mk('proj_sp_stguard2');
    setViewpoint('proj_sp_stguard2', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '守卫2' });
    const w = await t.write({ tag: '状态表', text: '状态表\r\rn| 键 | 值 |\r\rn| --- | --- |\r\rn| 好感度 | 0 |' });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/载重|解析不出/);
    const b = await readBoard('proj_sp_stguard2');
    expect(Object.keys(b.objects || {}).filter((k) => k.startsWith('notes/板书/'))).toHaveLength(0);
  });

  it('CRLF 老实换行在写口归一化，不进守卫的黑名单', async () => {
    const t = await mk('proj_sp_stguard3');
    setViewpoint('proj_sp_stguard3', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '守卫3' });
    const w = await t.write({ tag: '状态表', text: '状态表\r\n\r\n| 键 | 值 |\r\n| --- | --- |\r\n| 好感度 | 7 |' });
    expect(w.isError).toBeUndefined();
    const { readStateVars } = await import('../../../lib/state-table.js');
    const live = await readStateVars((await import('../../../projects/workspace.js')).getSharedDir('proj_sp_stguard3'));
    expect(live.state).toBe('ok');
    expect(live.rows.find((x) => x.key === '好感度').value).toBe('7');
  });
});
