/**
 * 幽灵卡与量具说谎（2026-08-31，proj_mtgeaeps_7kly 真会话）。
 *
 * 站主原话「这里的 agent 好像完全不知道画布排布为何物」。查下来 agent 流程一步
 * 没错（read_board → open_sheet 带 plan → 写进 slot → pin 进 slot → 画关系线），
 * 是它的量具在骗它：
 *
 *   ① pin 一份 .docx，id 停在裸路径 → 前端不渲染 → 屏幕上什么也没发生，
 *      工具却报 Placed；那张卡身上的关系线也一条都画不出来。
 *   ② 收产物的版位规划成 360 宽，而 docx 卡恒宽 640 —— nextSpotInSlot 只查高
 *      不查宽，于是「装下了」，实际向右溢出 280px。
 *   ③ 铺纸把暂存架的竖带盖住了，但架原点只在「真有东西上架」时才回写，
 *      前端一直照着失效的旧原点排新到货。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ghost-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeOpenSheetTool } = await import('./open-sheet.js');
const { makePinToBoardTool } = await import('./pin-to-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { _resetSheetState } = await import('../../../lib/sheet-state.js');
const { cardIdOf } = await import('../../../../web/src/lib/board-kinds.js');

const ctx = { emit() {} };
const mk = async (pid) => {
  await ensureProjectWorkspace(pid);
  const sharedRoot = getSharedDir(pid);
  return {
    sharedRoot,
    open: (a = {}) => makeOpenSheetTool({ projectId: pid, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    pin: (a) => makePinToBoardTool({ sharedRoot, projectId: pid, sessionId: `${pid}-s`, ctx }).handler(a, {}),
    board: () => readBoard(pid),
  };
};
const text = (r) => r.content[0].text;

beforeAll(() => { _resetViewpoints(); _resetSheetState(); });

describe('① pin 一份 .docx：卡 id 必须是前端真会渲染的那一个', () => {
  it('⭐⭐ 落盘 id 带 docx: 前缀，且跟前端 cardIdOf 给的一致', async () => {
    const t = await mk('proj_ghost_docx');
    setViewpoint('proj_ghost_docx', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await fs.writeFile(path.join(t.sharedRoot, '简历v8.docx'), 'PKfake');
    await t.open({ title: '母稿', plan: [{ slot: 'art', at: { x: 0, y: 0 }, w: 700, h: 900, for: 'artifacts', about: '产物' }] });

    const r = await t.pin({ path: '简历v8.docx', slot: 'art' });
    expect(r.isError, text(r)).toBeUndefined();

    const b = await t.board();
    const want = cardIdOf('', { kind: 'docx', file: '简历v8.docx' });
    expect(want).toBe('docx:简历v8.docx');
    expect(Object.keys(b.objects), '裸路径 id = 前端不渲染的幽灵条目').not.toContain('简历v8.docx');
    expect(b.objects[want], '应当以正字法 id 落座').toBeTruthy();
    // 报文里说的地址要跟真落座的是同一个（工具返回不许撒谎）
    expect(text(r)).toContain(want);
  });

  it('.md 不是产物，照旧按裸路径落座（那本来就是普通文件卡）', async () => {
    const t = await mk('proj_ghost_md');
    setViewpoint('proj_ghost_md', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await fs.writeFile(path.join(t.sharedRoot, '笔记.md'), '# hi');
    await t.open({ title: '页', plan: [{ slot: 'a', at: { x: 0, y: 0 }, w: 700, h: 900, for: 'artifacts', about: 'x' }] });
    const r = await t.pin({ path: '笔记.md', slot: 'a' });
    expect(r.isError, text(r)).toBeUndefined();
    expect(Object.keys(await t.board().then(b => b.objects))).toContain('笔记.md');
  });
});

describe('② 版位装不下宽度要如实拒收', () => {
  it('⭐ 360 宽的版位收不下 640 宽的 docx 卡：拒收并说清是宽不是高', async () => {
    const t = await mk('proj_ghost_narrow');
    setViewpoint('proj_ghost_narrow', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await fs.writeFile(path.join(t.sharedRoot, '报告.docx'), 'PKfake');
    await t.open({ title: '窄', plan: [{ slot: 'art', at: { x: 0, y: 0 }, w: 360, h: 900, for: 'artifacts', about: '产物' }] });

    const r = await t.pin({ path: '报告.docx', slot: 'art' });
    expect(r.isError, '装不下就该拒收，不能溢出到隔壁还报成功').toBe(true);
    expect(text(r)).toMatch(/wide/i);
    const b = await t.board();
    expect(b.objects['docx:报告.docx']?.x, '拒收了就不该留下座位').toBeUndefined();
  });
});

describe('③ 铺纸盖住架带：原点当场回写，不等到下次有东西上架', () => {
  it('⭐⭐ 架立在纸群正上方 → open_sheet 之后 board.shelf 已经搬开', async () => {
    const t = await mk('proj_ghost_shelf');
    setViewpoint('proj_ghost_shelf', { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    // 架先立在 (24,24)：还没有纸的时候这是合法的（视口左上）
    await patchBoard('proj_ghost_shelf', { shelf: { x: 24, y: 24 } });
    await t.open({ title: '第一张' });

    const b = await t.board();
    const sh = Object.values(b.sheets)[0];
    expect(b.shelf, '架原点应当已经回写').toBeTruthy();
    const overlaps = sh.x < b.shelf.x + 360 && sh.x + sh.w > b.shelf.x;
    expect(overlaps, `架带 x[${b.shelf.x},${b.shelf.x + 360}) 还压在纸 x[${sh.x},${sh.x + sh.w}) 上`).toBe(false);
  });
});
