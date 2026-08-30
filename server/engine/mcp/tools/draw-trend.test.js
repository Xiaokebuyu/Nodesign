/**
 * draw_trend 真 handler（2026-08-30 活图第一块）。
 * 判据：画得出（三笔一签+落在状态表卡下）、重画原地（用户拖过也认）、
 * 点不够大声拒。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-drawtrend-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const run = promisify(execFile);
const { makeDrawTrendTool } = await import('./draw-trend.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace, commitWorkspace } = await import('../../../projects/workspace.js');
const { renderChalk, CHALK_DIR } = await import('../../../lib/chalk.js');
const { STATE_TABLE_TAG } = await import('../../../lib/state-table.js');

const pid = 'proj_drawtrend_test';
const REL = `${CHALK_DIR}/20260830-120000-状态.md`;
let call;

const T = (v) => `## 状态\n\n| 键 | 值 |\n| --- | --- |\n| 好感度 | ${v} |`;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  const sharedRoot = getSharedDir(pid);
  await fs.mkdir(path.join(sharedRoot, CHALK_DIR), { recursive: true });
  for (const v of [2, 5, 8]) {
    await fs.writeFile(path.join(sharedRoot, REL), renderChalk({ body: T(v), by: 'agent', tag: STATE_TABLE_TAG }));
    await commitWorkspace(pid, null, `beat ${v}`);
  }
  await patchBoard(pid, { objects: { [REL]: { x: 100, y: 100, w: 400, h: 300 } } });
  call = (args) => makeDrawTrendTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx: { emit() {} } }).handler(args, {});
});

describe('draw_trend', () => {
  it('⭐ 画出三件套（曲线/基线/现值圈）+ 标签，落在状态表卡正下方', async () => {
    const r = await call({ key: '好感度' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/3 points \(2 → 5 → 8\)/);
    const b = await readBoard(pid);
    const group = Object.entries(b.objects).filter(([, e]) => e.tag === 'trend-好感度');
    expect(group).toHaveLength(4);
    const ys = group.map(([, e]) => e.y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(400);   // 卡底 100+300 之下
  });

  it('⭐ 重画原地：用户把图拖走，再画还在他摆的地方', async () => {
    const b0 = await readBoard(pid);
    const patch = {};
    for (const [id, e] of Object.entries(b0.objects)) {
      if (e.tag === 'trend-好感度') patch[id] = { ...e, x: e.x + 500, y: e.y + 200, seat: 'user' };
    }
    await patchBoard(pid, { objects: patch });
    const r = await call({ key: '好感度' });
    expect(r.content[0].text).toMatch(/redrawn in place/);
    const b1 = await readBoard(pid);
    const group = Object.entries(b1.objects).filter(([, e]) => e.tag === 'trend-好感度');
    expect(group).toHaveLength(4);                          // 没越叠越多
    expect(Math.min(...group.map(([, e]) => e.x))).toBeGreaterThanOrEqual(600);
  });

  it('⛔ 键不存在 / 只有一个点，大声拒', async () => {
    const r = await call({ key: '没这键' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/没有「没这键」/);
  });
});
