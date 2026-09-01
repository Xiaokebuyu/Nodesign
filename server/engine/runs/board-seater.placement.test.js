/**
 * 产物入座的落位契约（2026-08-30 暂存架版）。
 *
 * 刀 G（入座不铺纸、排不下进队列）当天就被真板打脸：proj_mtfz7n8p 里 web_search
 * 采回的参考图撞进「开工例外」，第一张纸还是机器铺的。站主拍板收成暂存架范式，
 * 这里钉的是三条最贵的行为：**机器完全不产纸**、**机器不往纸面顺排**、
 * **没规划的到货（含文件夹卡）一律上架**。
 *
 * ⚠️ 判据先验一遍：每条断言先造一个**它必须拦住**的局面，再看它拦没拦。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-seat-g-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { seatArtifacts } = await import('./board-seater.js');
const { readBoard, patchBoard } = await import('../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../projects/viewpoint-store.js');
const { SHELF_W, SHELF_GAP } = await import('../../lib/board-shelf.js');

let n = 0; let projectId;
beforeEach(async () => {
  // 一个 case 一个项目：板是有状态的，共用一块板等于让上一条测试的残留当输入
  n += 1; projectId = `proj_seat_g_${n}`;
  await ensureProjectWorkspace(projectId);
  _resetViewpoints();
  setViewpoint(projectId, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
});

const touch = async (rel) => {
  const abs = path.join(getSharedDir(projectId), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'x');
  return rel;
};

const emptySheet = { x: 0, y: 0, w: 1600, h: 900, at: '2026-08-30T01:00:00Z', by: 'agent' };

describe('暂存架：机器的手只够得到架', () => {
  it('⭐⭐ 一张纸都没有 → **不铺纸**，上架（视口左上，seat:shelf，原点落盘）', async () => {
    await touch('assets/a.png');
    const r = await seatArtifacts(projectId, ['assets/a.png']);
    const b = await readBoard(projectId);
    // 这就是"它必须拦住"的局面：改回开工例外的话 sheets 会变成 1
    expect(Object.keys(b.sheets || {})).toHaveLength(0);
    expect(r.seated).toBe(1);
    expect(r.shelved).toBe(1);
    const e = b.objects['assets/a.png'];
    expect(e.seat).toBe('shelf');
    expect(e.x).toBe(24);   // camera.x + SHELF_GAP
    expect(b.shelf).toEqual({ x: 24, y: 24 });
  });

  it('⭐⭐ 有纸、纸还空着 → 也**不往纸面顺排**，上架在纸群左侧', async () => {
    await patchBoard(projectId, { sheets: { p1: emptySheet } });
    await touch('assets/a.png');
    await seatArtifacts(projectId, ['assets/a.png']);
    const b = await readBoard(projectId);
    const e = b.objects['assets/a.png'];
    // 拦住的局面：老逻辑会把它放进版心 (24,24)；现在必须在纸外左侧
    expect(e.seat).toBe('shelf');
    expect(e.x).toBe(0 - SHELF_W - SHELF_GAP);
    expect(Object.keys(b.sheets)).toEqual(['p1']);
  });

  it('⭐ 旧 board.pending 队列并进架上（从看不见变看得见），队列清空要写回', async () => {
    await touch('assets/big.png');
    await patchBoard(projectId, { sheets: { p1: emptySheet }, pending: ['assets/big.png'] });
    const r = await seatArtifacts(projectId, []);          // 新文件一个都没有，只清队列
    const b = await readBoard(projectId);
    expect(r.seated).toBe(1);
    expect(b.pending).toBeUndefined();
    expect(b.objects['assets/big.png'].seat).toBe('shelf');
  });

  /**
   * ⛔ 2026-09-01 刀 2：这条原来钉的是「规划了 for:'artifacts' 的地 → 产物落进
   * 那块地，不上架」。版位退役，那一档整个撤了 —— **机器从此只码架**，一档不留。
   * 产物的归宿改由 agent 一件件 pin_to_board 请下来。所以这里钉的换成
   * 「有纸也照样上架」，正是那条纪律最容易被人偷偷加回去的地方。
   */
  it('⭐⭐ 板上有纸也照样上架 —— 机器一档都不产版面', async () => {
    await patchBoard(projectId, { sheets: { p1: {
      x: 0, y: 0, w: 1600, h: 900, at: '2026-08-30T01:00:00Z', by: 'agent',
    } } });
    await touch('assets/a.png');
    const r = await seatArtifacts(projectId, ['assets/a.png']);
    const e = (await readBoard(projectId)).objects['assets/a.png'];
    expect(e.seat).toBe('shelf');
    expect(r.shelved).toBe(1);
  });

  it('_drafts/ 永不入座，也不上架（那是纪律不是"没地方"）', async () => {
    const r = await seatArtifacts(projectId, ['_drafts/x.html']);
    expect(r.seated).toBe(0);
    expect((await readBoard(projectId)).objects['_drafts/x.html']).toBeUndefined();
  });

  it('⭐ 文件夹卡也上架：新顶层目录得到架上的卡位，文件归进文件夹层', async () => {
    await touch('小说/第一章.md');
    await touch('说明.md');
    await seatArtifacts(projectId, ['小说/第一章.md', '说明.md']);
    const b = await readBoard(projectId);
    expect(b.zones['小说']).toBeTruthy();
    expect(b.zones['小说'].x).toBe(24);            // 架的列上
    const chapter = b.objects['小说/第一章.md'];
    expect(chapter.zone).toBe('小说');             // 住进文件夹层，不在根桌面
    const readme = b.objects['说明.md'];
    expect(readme.seat).toBe('shelf');
    // 2026-09-01 架改成一摞：文件夹卡和散文件**叠在同一个架位**上，一次显示
    // 最上面那件。原来这儿钉的是「码在文件夹卡下面不压它」，那是竖列时代的
    // 契约 —— 一摞本来就是叠着的，"不压"这件事由渲染层只画一件来保证。
    expect({ x: readme.x, y: readme.y }).toEqual({ x: b.zones['小说'].x, y: b.zones['小说'].y });
  });

  it('保留目录不长文件夹卡：assets/ 下的东西上架但不出 assets 卡', async () => {
    await touch('assets/references/ref-1.jpg');
    await seatArtifacts(projectId, ['assets/references/ref-1.jpg']);
    const b = await readBoard(projectId);
    expect(b.zones['assets']).toBeUndefined();
    expect(b.objects['assets/references/ref-1.jpg'].seat).toBe('shelf');
  });
});
