/**
 * 预留座释放时机（2026-09-13）：CLI 块闭合即派发，上一条板书正在落盘时下一条就可能在预解算。
 * 钉两件事：落盘途中预留座还在（下一条躲得开）；调用结束（成功或报错）后预留座一定释放。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 写板书文件那一步挂起，模拟「文件写完、板还没写」的那段 await
const hold = vi.hoisted(() => {
  let release; let entered;
  const state = { armed: false };
  state.reset = () => {
    state.gate = new Promise((r) => { release = r; });
    state.entered = new Promise((r) => { entered = r; });
    state.release = () => release();
    state.enter = () => entered();
  };
  return state;
});
vi.mock('../../../lib/chalk.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    writeChalkFile: async (...a) => {
      if (hold.armed) { hold.enter(); await hold.gate; }
      return orig.writeChalkFile(...a);
    },
  };
});

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-wob-rsv-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { getReservation, _resetReservations } = await import('../../../lib/board-reservations.js');

const pid = 'proj_wob_reservation';
let sharedRoot; let tool; let previewer;
const extraFor = (id) => ({ _meta: { 'claudecode/toolUseId': id } });
const overlaps = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
  const ctx = { emit: () => {} };
  tool = makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx });
  previewer = ctx.spotPreviewers.mcp__nodesign__write_on_board;
  _resetViewpoints(); _resetReservations();
  await patchBoard(pid, { objects: { 'assets/锚.png': { x: 1000, y: 1000, w: 200, h: 176 } } });
  setViewpoint(pid, { camera: { x: 0, y: 0, w: 1600, h: 1000 }, layer: '' });
});

describe('预留座释放时机', () => {
  it('⭐ 上一条落盘途中，下一条的预解算仍然躲开它；落完后预留座释放、落点不变', async () => {
    const a = await previewer.solve({ near: 'assets/锚.png', text: '甲' }, 'toolu_A');
    expect(a).not.toBeNull();

    hold.reset(); hold.armed = true;
    const pending = tool.handler({ near: 'assets/锚.png', text: '甲写完了' }, extraFor('toolu_A'));
    await hold.entered;                       // 停在写文件那一步：落位已算完，板还没写

    // 判据自检：这一刻板上确实还没有甲（否则下面那条躲开恒真）
    const notes = Object.keys((await readBoard(pid)).objects).filter((id) => id.startsWith('notes/板书/'));
    expect(notes).toEqual([]);
    expect(getReservation(pid, 'toolu_A')).not.toBeNull();

    const b = await previewer.solve({ near: 'assets/锚.png', text: '乙' }, 'toolu_B');
    expect(b).not.toBeNull();
    expect(overlaps(a, b), `乙 ${JSON.stringify(b)} 跟甲 ${JSON.stringify(a)} 重叠`).toBe(false);

    hold.armed = false; hold.release();
    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect(getReservation(pid, 'toolu_A')).toBeNull();
    const board = await readBoard(pid);
    const placed = Object.entries(board.objects).find(([id]) => id.startsWith('notes/板书/'))?.[1];
    expect({ x: placed.x, y: placed.y }).toEqual({ x: a.x, y: a.y });
    _resetReservations();
  });

  it('调用报错提前返回，预留座也释放（不留两分钟的幽灵占地）', async () => {
    const c = await previewer.solve({ near: 'assets/锚.png', text: '丙' }, 'toolu_C');
    expect(c).not.toBeNull();
    const r = await tool.handler({ near: 'assets/锚.png', text: '丙', nodes: [{ text: 'x' }] }, extraFor('toolu_C'));
    expect(r.isError).toBe(true);
    expect(getReservation(pid, 'toolu_C')).toBeNull();
  });
});
