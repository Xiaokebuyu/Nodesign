import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（跟其它服务端测试同一套纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-board-race-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { readBoard, patchBoard } = await import('./board-store.js');
const { ensureProjectWorkspace, getSharedDir } = await import('./workspace.js');

const pid = 'proj_boardrace_test';

// 09-12：board.json 以前是 fs.writeFile 直接写（先清空再写入），锁外的 readBoard 正好在这一下读，
// 解析失败就返回空画布。修之前这个测试在 Linux 上就能读到几十次空画布，Windows 更多
// （board-tasklist「重启后认领旧便签」在 Windows CI 反复超时的真因）。
describe('board.json 边写边读', () => {
  beforeAll(async () => {
    await ensureProjectWorkspace(pid);
    const objects = {};
    for (let i = 0; i < 80; i += 1) objects[`assets/x${i}.png`] = { x: i * 10, y: i * 10, w: 200, h: 150, by: 'agent', tag: 'seed' };
    await patchBoard(pid, { objects });
  });

  it('写的同时去读，永远读到完整的画布（不会读成空的）', async () => {
    let reads = 0; let empty = 0; let stop = false;
    const reader = (async () => {
      while (!stop) {
        const b = await readBoard(pid);
        reads += 1;
        if (Object.keys(b.objects).length !== 80) empty += 1;
      }
    })();
    for (let i = 0; i < 150; i += 1) await patchBoard(pid, { objects: { [`assets/x${i % 80}.png`]: { x: i } } });
    stop = true;
    await reader;
    expect(reads).toBeGreaterThan(50);   // 真的边写边读了，不是写完才读
    expect(empty).toBe(0);
  }, 30_000);

  it('写完不留临时文件', async () => {
    const left = (await fs.readdir(getSharedDir(pid))).filter(n => n.endsWith('.tmp'));
    expect(left).toEqual([]);
  });
});
