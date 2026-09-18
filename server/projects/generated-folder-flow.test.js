/**
 * 生成图文件夹（09-18）的服务端几条规矩：
 *   - 旧板桌面件（desk）归根层，新图归「生成图」层
 *   - 生成图文件夹本身不搬；只收图和视频；旧桌面件拖进去 = 清 desk 归档；搬过一次 desk 就清
 *   - 入座器给第一张新图建「生成图」文件夹卡，图坐进文件夹那一层
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-genflow-'));
process.env.PROJECTS_DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, 'test.db');
const { moveEntry, MoveError } = await import('./move-entry.js');
const { readBoard } = await import('./board-store.js');
const { layerOf } = await import('../lib/canvas-id.js');
const { seatArtifacts } = await import('../engine/runs/board-seater.js');
const { zoneRects } = await import('../lib/board-kind-sizes.js');

let n = 0; let PID; let root;
const w = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const writeBoard = (b) => fs.writeFileSync(path.join(root, 'board.json'), JSON.stringify({ zones: {}, objects: {}, bindings: {}, ...b }));

beforeEach(() => {
  n += 1; PID = `proj_genflow${String(n).padStart(4, '0')}_x`;
  root = path.join(tmp, PID, 'shared');
  w('assets/generated/old.png'); w('assets/generated/new.png'); w('稿/说明.md');
  writeBoard({ zones: { 'assets/generated': { x: 0, y: 0 } }, objects: { 'assets/generated/old.png': { x: 5, y: 5, desk: true } } });
});

describe('layerOf', () => {
  it('⭐ 旧板桌面件归根层，同目录的新图归生成图文件夹', () => {
    const known = new Set(['assets/generated']);
    expect(layerOf('assets/generated/old.png', { x: 5, y: 5, desk: true }, known)).toBe('');
    expect(layerOf('assets/generated/new.png', null, known)).toBe('assets/generated');
    expect(layerOf('稿/old.png', { desk: true }, new Set(['稿']))).toBe('稿');   // desk 只在生成图目录里算数
  });
});

describe('moveEntry 与生成图文件夹', () => {
  it('⛔ 文件夹本身不搬', async () => {
    await expect(moveEntry(PID, 'assets/generated', '稿')).rejects.toSatisfy((e) => e instanceof MoveError && e.status === 400);
  });

  it('只收图和视频：md 搬不进去', async () => {
    await expect(moveEntry(PID, '稿/说明.md', 'assets/generated')).rejects.toSatisfy((e) => e instanceof MoveError && /只收图和视频/.test(e.message));
    w('稿/a.png');
    const out = await moveEntry(PID, '稿/a.png', 'assets/generated');
    expect(out.to).toBe('assets/generated/a.png');
  });

  it('⭐ 旧桌面件拖进生成图文件夹卡：文件不动，desk 清掉', async () => {
    const out = await moveEntry(PID, 'assets/generated/old.png', 'assets/generated');
    expect(out).toMatchObject({ moved: false, filed: true });
    expect((await readBoard(PID)).objects['assets/generated/old.png'].desk).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'assets/generated/old.png'))).toBe(true);
  });

  it('搬过一次 desk 就清（再搬回来不会又冒回桌面）', async () => {
    await moveEntry(PID, 'assets/generated/old.png', '稿');
    const b = await readBoard(PID);
    expect(b.objects['稿/old.png']).toMatchObject({ x: 5, y: 5 });
    expect(b.objects['稿/old.png'].desk).toBeUndefined();
  });
});

describe('入座器', () => {
  it('⭐ 第一张新图：建生成图文件夹卡，图坐进文件夹那一层', async () => {
    writeBoard({});
    await seatArtifacts(PID, ['assets/generated/new.png']);
    const b = await readBoard(PID);
    expect(Number.isFinite(b.zones['assets/generated']?.x)).toBe(true);
    expect(layerOf('assets/generated/new.png', b.objects['assets/generated/new.png'], new Set(Object.keys(b.zones)))).toBe('assets/generated');
  });
});

describe('zoneRects', () => {
  it('⭐ 生成图文件夹卡算桌面层的障碍（直接上级 assets/ 不是层）；普通子文件夹照旧挂父层', () => {
    const board = { zones: { 'assets/generated': { x: 0, y: 0 }, 稿: { x: 400, y: 0 }, '稿/初稿': { x: 0, y: 0 } } };
    expect(zoneRects(board, { layer: '' }).map((z) => z.id).sort()).toEqual(['assets/generated', '稿']);
    expect(zoneRects(board, { layer: '稿' }).map((z) => z.id)).toEqual(['稿/初稿']);
  });
});
