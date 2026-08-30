/**
 * 刀 G：产物入座进占位契约（2026-08-30）。
 *
 * 站主拍板「产物也需要 agent 提前规划放置位置落在纸上，甚至包括文件夹」。这里钉的
 * 是那条最贵的行为改变：**入座不再自己铺纸**。
 *
 * 为什么值得单独钉：这个 bug 在真板上留了痕迹却一直没人发现（proj_mtfix5rv 的 p1 是
 * 入座顺手铺的，没标题没版位署名 agent，agent 自己都不知道它存在）。它不报错、不掉
 * 数据，只是悄悄替 agent 定了版面 —— 只有专门给它一张"排不下"的板才看得见。
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
/**
 * 一张**真的写满了**的纸。
 * ⚠️ 判据先验一遍才发现的坑：一开始我把纸做成 h:108 想让它装不下任何东西 ——
 * sanitizeSheet 把高度钳回下限 240，纸其实空着，产物照样坐得下，于是"拦住了"
 * 这条断言恒假地过不去。真要让它满，得往里塞一件填满版心的东西。
 */
const fullSheet = { x: 0, y: 0, w: 800, h: 500, at: '2026-08-30T01:00:00Z', by: 'agent' };
const fillIt = { 'notes/板书/占满.md': { x: 24, y: 24, w: 700, h: 440, z: 1, zone: '', seat: 'agent', by: 'agent' } };

describe('刀 G：入座不再自己铺纸', () => {
  it('⭐ 一张纸都没有 → 照旧铺第一张（那是开工，不是翻页）', async () => {
    await touch('assets/a.png');
    const r = await seatArtifacts(projectId, ['assets/a.png']);
    const b = await readBoard(projectId);
    expect(r.seated).toBe(1);
    expect(Object.keys(b.sheets || {})).toHaveLength(1);
    expect(b.pending).toBeUndefined();
  });

  it('⭐⭐ 有纸但排不下 → **一张新纸都不许铺**，进待摆队列', async () => {
    await patchBoard(projectId, { sheets: { p1: fullSheet }, objects: fillIt });
    await touch('assets/big.png');
    const r = await seatArtifacts(projectId, ['assets/big.png']);
    const b = await readBoard(projectId);
    // 这就是"它必须拦住"的那个局面：改回自动翻页的话 sheets 会变成 2、seated 变成 1
    expect(Object.keys(b.sheets)).toEqual(['p1']);
    expect(r.seated).toBe(0);
    expect(r.pending).toBe(1);
    expect(b.pending).toEqual(['assets/big.png']);
    expect(b.objects['assets/big.png']).toBeUndefined();
  });

  it('⭐ 待摆的会重试：agent 规划出地方之后，下一批自动落座并出队', async () => {
    await patchBoard(projectId, { sheets: { p1: fullSheet }, objects: fillIt });
    await touch('assets/big.png');
    await seatArtifacts(projectId, ['assets/big.png']);
    expect((await readBoard(projectId)).pending).toEqual(['assets/big.png']);

    // agent 开了一张真能放下东西的纸
    await patchBoard(projectId, { sheets: { p2: { x: 0, y: 400, w: 1200, h: 900, at: '2026-08-30T02:00:00Z', by: 'agent' } } });
    const r = await seatArtifacts(projectId, []);          // 新文件一个都没有，只重试队列
    const b = await readBoard(projectId);
    expect(r.seated).toBe(1);
    expect(b.pending).toBeUndefined();                      // 队列清空也要写回
    expect(b.objects['assets/big.png']).toBeDefined();
  });

  it('⭐⭐ 规划了 for:"artifacts" 的地 → 产物落进那块地，不是纸内顺排', async () => {
    await patchBoard(projectId, { sheets: { p1: {
      x: 0, y: 0, w: 1600, h: 900, at: '2026-08-30T01:00:00Z', by: 'agent',
      slots: { main: { x: 0, y: 0, w: 600, h: 800 }, 图: { x: 700, y: 0, w: 400, h: 800, for: 'artifacts' } },
    } } });
    await touch('assets/a.png');
    await seatArtifacts(projectId, ['assets/a.png']);
    const e = (await readBoard(projectId)).objects['assets/a.png'];
    // 图块的世界左缘 = 纸 x + margin 24 + slot.x 700
    expect(e.x).toBe(724);
    // 对照：没有这块地时它会落在版心左上（24）—— 断言不是恒真的
    expect(e.x).not.toBe(24);
  });

  it('_drafts/ 永不入座，也不进待摆队列（那是纪律不是"没地方"）', async () => {
    await patchBoard(projectId, { sheets: { p1: fullSheet }, objects: fillIt });
    const r = await seatArtifacts(projectId, ['_drafts/x.html']);
    expect(r.seated).toBe(0);
    expect((await readBoard(projectId)).pending).toBeUndefined();
  });
});
