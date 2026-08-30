/**
 * 暂存架和纸抢同一根竖列（2026-08-30，proj_mtg61or1 真会话）。
 *
 * 那块板最后长成这样：架从 y=24 一路码到 y=8322（板子声明高度 2600），26 件
 * 里 22 件落在没有任何纸的空地上，前端 ShelfHint 按包络画出来是个 228x8346、
 * 宽高比 1:41 的虚线框，横穿全部四张纸。用户的原话是「两个产物之间间隔很大
 * 的距离放置」。
 *
 * 四条独立的病串成一个棘轮，这个文件一条钉一发：
 *   ① 架的原点判据只测一个点 → 架立在纸群正上方永远判不出冲突，一路长穿每张纸
 *   ② 接楼被正下方挡住 → 误报「整张纸满了」→ agent 多开纸 → 棘轮再转一格
 *   ③ pin 进版位的文件夹文件互相隐形 → 后来的全叠在同一个坐标，还都报 success
 *   ④ organize_board 撞一个重名就撂挑子 → 暂存架从头到尾没清过
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-shelfcol-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeOpenSheetTool } = await import('./open-sheet.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { makePinToBoardTool } = await import('./pin-to-board.js');
const { makeOrganizeBoardTool } = await import('./organize-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { _resetSheetState } = await import('../../../lib/sheet-state.js');

const ctx = { emit() {} };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const mk = async (pid) => {
  await ensureProjectWorkspace(pid);
  const sharedRoot = getSharedDir(pid);
  return {
    sharedRoot,
    open: (a = {}) => makeOpenSheetTool({ projectId: pid, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    write: (a) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    pin: (a) => makePinToBoardTool({ sharedRoot, projectId: pid, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    organize: (a) => makeOrganizeBoardTool({ projectId: pid, ctx }).handler(a, {}),
    board: () => readBoard(pid),
  };
};
const text = (r) => r.content[0].text;

beforeAll(() => { _resetViewpoints(); _resetSheetState(); });

describe('③ pin 进版位：文件夹里的文件不能互相隐形', () => {
  it('⭐ 连 pin 五张同一文件夹的图进同一个版位 → 五个不同落点，且 zone 写根层', async () => {
    const t = await mk('proj_shelf_pin');
    setViewpoint('proj_shelf_pin', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await fs.mkdir(path.join(t.sharedRoot, '素材/官方参考'), { recursive: true });
    const names = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'];
    for (const n of names) await fs.writeFile(path.join(t.sharedRoot, '素材/官方参考', n), PNG);
    /**
     * ⛔ 这两行是这条测试的**前提**，不是布景：layerOf 只把 board.zones 里
     * 真有的目录当层。不登记文件夹卡的话这些文件一律归根层，病根碰都碰不到 ——
     * 第一版就是这么写的，源码回退后测试照样绿。文件夹卡摆得远远的，免得它
     * 自己变成版位里的障碍把几何搅乱。
     */
    await patchBoard('proj_shelf_pin', { zones: { 素材: { x: 3000, y: 3000 }, '素材/官方参考': { x: 3400, y: 3000 } } });

    // 900px 高的版位、200x176 的图卡、24 间隔 → 纵向真只装得下 4 张。
    // 修好之前：五张全报 success 且全叠在同一个坐标（真案 19:18 那五发）。
    // 修好之后：四张各自落位，第五张如实拒收。
    await t.open({ title: '素材纸', plan: [{ slot: 'refs', at: { x: 0, y: 0 }, w: 1100, h: 900, for: 'artifacts', about: '参考图' }] });
    const outs = [];
    for (const n of names) outs.push(await t.pin({ path: `素材/官方参考/${n}`, slot: 'refs' }));
    for (const [i, r] of outs.slice(0, 4).entries()) {
      expect(r.isError, `${names[i]} 应当 pin 成功：${text(r)}`).toBeUndefined();
    }
    expect(outs[4].isError, '第五张应当被如实拒收，而不是叠上去').toBe(true);
    expect(text(outs[4])).toMatch(/full/i);

    const b = await t.board();
    const seats = names.slice(0, 4).map((n) => b.objects[`素材/官方参考/${n}`]).filter(Boolean);
    expect(seats.length).toBe(4);
    const ys = seats.map((e) => `${e.x},${e.y}`);
    expect(new Set(ys).size, `四张全落在 ${ys[0]} 上了：${ys.join(' | ')}`).toBe(4);
    // 摆到纸上就是摆到根层：zone 写文件夹层的话前端把它渲染进文件夹里，
    // 根层画布上根本看不见 —— 而工具还报了「Placed on sheet ... at (x,y)」
    for (const e of seats) expect(e.zone).toBe('');
  });

  it('版位真装满了要如实拒收，不能靠隐形装下无限张', async () => {
    const t = await mk('proj_shelf_pinfull');
    setViewpoint('proj_shelf_pinfull', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await fs.mkdir(path.join(t.sharedRoot, '素材'), { recursive: true });
    for (let i = 0; i < 4; i += 1) await fs.writeFile(path.join(t.sharedRoot, '素材', `x${i}.png`), PNG);
    await patchBoard('proj_shelf_pinfull', { zones: { 素材: { x: 3000, y: 3000 } } });
    await t.open({ title: '窄版位', plan: [{ slot: 'tiny', at: { x: 0, y: 0 }, w: 400, h: 200, for: 'artifacts', about: '小块' }] });
    const outs = [];
    for (let i = 0; i < 4; i += 1) outs.push(await t.pin({ path: `素材/x${i}.png`, slot: 'tiny' }));
    expect(outs.some((r) => r.isError && /full/i.test(text(r))), '窄版位应当报满').toBe(true);
  });
});

describe('② 接楼接不下去 ≠ 整张纸满了', () => {
  it('⭐ 母板书正下方被挡 → 同一张纸顺排，不再谎报 sheet is full', async () => {
    const t = await mk('proj_shelf_thread');
    setViewpoint('proj_shelf_thread', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await t.open({ title: '一栏' });
    const first = await t.write({ text: '母板书：这一条底下等会儿会被一件大东西堵住。' });
    expect(first.isError).toBeUndefined();
    const parent = (await t.board()) && Object.keys((await t.board()).objects).find((k) => k.startsWith('notes/板书/'));
    expect(parent).toBeTruthy();

    // 在母板书正下方塞一件很高的东西，把这条线堵死（真案里是 960x628 的试作站点卡）
    const b0 = await t.board();
    const p = b0.objects[parent];
    await fs.mkdir(path.join(t.sharedRoot, '素材'), { recursive: true });
    await fs.writeFile(path.join(t.sharedRoot, '素材/blocker.png'), PNG);
    await t.pin({ path: '素材/blocker.png', at: { x: p.x, y: p.y + p.h + 24 } });
    const b1 = await t.board();
    const blocker = b1.objects['素材/blocker.png'];
    await (await import('../../../projects/board-store.js')).patchBoard('proj_shelf_thread', {
      objects: { '素材/blocker.png': { ...blocker, w: 900, h: 1100 } },
    });

    const reply = await t.write({ reply_to: parent, text: '回应：接楼的正下方被堵住了，但这张纸右边还空着大半。' });
    expect(reply.isError, `不该报纸满：${text(reply)}`).toBeUndefined();
    expect(text(reply)).not.toMatch(/is full/i);
    const b2 = await t.board();
    const written = Object.keys(b2.objects).filter((k) => k.startsWith('notes/板书/'));
    expect(written.length, '回复应当真的落在板上').toBe(2);
    const sheet = Object.values(b2.sheets)[0];
    const me = b2.objects[written.find((k) => k !== parent)];
    expect(me.x, '正下方那一列被 900px 宽的东西占死了，应当挪到右边一栏').toBeGreaterThan(blocker.x + 900);
    expect(me.y, '应当还在这张纸里').toBeLessThan(sheet.y + sheet.h);
    expect(me.y + me.h, '应当还在这张纸里').toBeLessThanOrEqual(sheet.y + sheet.h);
    expect(Object.keys(b2.sheets).length, '不该为这条回复另开一张纸').toBe(1);
  });
});

describe('④ organize_board：重名跳过，其余照搬', () => {
  it('⭐ 第一件重名不再让后面十几件全都不动', async () => {
    const t = await mk('proj_shelf_org');
    await fs.mkdir(path.join(t.sharedRoot, 'assets/references'), { recursive: true });
    await fs.mkdir(path.join(t.sharedRoot, '素材/官方参考'), { recursive: true });
    const names = ['dup.png', 'one.png', 'two.png', 'three.png'];
    for (const n of names) await fs.writeFile(path.join(t.sharedRoot, 'assets/references', n), PNG);
    // 目标夹里先放一个同名的：真案里 agent 早先 cp 过一份
    await fs.writeFile(path.join(t.sharedRoot, '素材/官方参考/dup.png'), PNG);

    const r = await t.organize({
      items: names.map((n) => `assets/references/${n}`),
      into: '素材/官方参考',
      rewrite_refs: false,
    });
    const out = text(r);
    expect(out, '重名那件应当报跳过').toMatch(/dup\.png[\s\S]*跳过/);
    expect(out).not.toMatch(/件没动/);
    for (const n of names.slice(1)) {
      await expect(fs.access(path.join(t.sharedRoot, '素材/官方参考', n)), `${n} 应当已经搬过去`).resolves.toBeUndefined();
    }
  });

  it('重名以外的失败照旧即停（这一刀不是"什么都不管接着搬"）', async () => {
    const t = await mk('proj_shelf_org2');
    await fs.mkdir(path.join(t.sharedRoot, 'assets/references'), { recursive: true });
    await fs.writeFile(path.join(t.sharedRoot, 'assets/references/ok.png'), PNG);
    const r = await t.organize({
      items: ['assets/references/不存在的东西.png', 'assets/references/ok.png'],
      into: '素材',
      rewrite_refs: false,
    });
    expect(text(r)).toMatch(/件没动/);
  });
});
