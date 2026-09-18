/**
 * 话题让开端到端（09-18）：agent 改字把一个话题撑长 → 撞上的话题整组让开，返回如实报；
 * 带 tag 钉东西时别的话题整块当障碍，不落进人家的空隙。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-topic0918-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeEditBoardTool } = await import('./edit-board.js');
const { makePinToBoardTool } = await import('./pin-to-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { renderChalk } = await import('../../../lib/chalk.js');

const pid = 'proj_topic_0918';
let root; let edit; let pin;
const put = async (rel, body = 'x') => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); };

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  root = getSharedDir(pid);
  const ctx = { emit: () => {} };
  edit = (args) => makeEditBoardTool({ projectId: pid, sharedRoot: root, ctx }).handler(args, {});
  pin = (args) => makePinToBoardTool({ projectId: pid, sharedRoot: root, ctx }).handler(args, {});
  await put('notes/板书/配色.md', renderChalk({ body: '主色暖橙', tag: '配色' }));
  await put('notes/板书/字体.md', renderChalk({ body: '标题宋体', tag: '字体' }));
  await put('notes/板书/字体2.md', renderChalk({ body: '正文黑体', tag: '字体' }));
  await put('cat.png', 'png');
  await patchBoard(pid, { objects: {
    'notes/板书/配色.md': { x: 0, y: 0, w: 432, h: 80, tag: '配色' },
    'notes/板书/字体.md': { x: 0, y: 160, w: 432, h: 80, tag: '字体' },
    'notes/板书/字体2.md': { x: 460, y: 160, w: 300, h: 80, tag: '字体' },
  } });
});

describe('话题让开', () => {
  it('⭐ 改字把 #配色 撑长 → #字体 整组让开，报文点名', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：配色的理由写长一点。`).join('\n\n');
    const r = await edit({ ops: [{ op: 'set_text', id: 'notes/板书/配色.md', text: long }] });
    const b = await readBoard(pid);
    const a = b.objects['notes/板书/配色.md'];
    const f1 = b.objects['notes/板书/字体.md']; const f2 = b.objects['notes/板书/字体2.md'];
    expect(a.h).toBeGreaterThan(160);
    expect(f1.x - 0).toBe(f2.x - 460);                  // 整组一起
    expect(f1.y - 160).toBe(f2.y - 160);
    const moved = f1.x !== 0 || f1.y !== 160;
    expect(moved).toBe(true);
    expect(r.content[0].text).toContain('#字体 整组让开了');
  });

  it('带 tag 钉东西：别的话题整块地盘当障碍，不落在它的包络里', async () => {
    await pin({ path: 'cat.png', place: { by: 'notes/板书/配色.md', side: 'right' }, tag: '配色' });
    const b = await readBoard(pid);
    const c = b.objects['cat.png'];
    const f1 = b.objects['notes/板书/字体.md']; const f2 = b.objects['notes/板书/字体2.md'];
    const x0 = Math.min(f1.x, f2.x) - 12; const y0 = Math.min(f1.y, f2.y) - 12;
    const x1 = Math.max(f1.x + f1.w, f2.x + f2.w) + 12; const y1 = Math.max(f1.y + f1.h, f2.y + f2.h) + 12;
    const inside = c.x < x1 && x0 < c.x + (c.w || 200) && c.y < y1 && y0 < c.y + (c.h || 176);
    expect(inside).toBe(false);
  });
});
