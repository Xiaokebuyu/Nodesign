/**
 * 状态表历史序列（2026-08-30 活图第一块）。
 * 判据：git 就是时间轴（每 commit 一点+盘上现值收尾）；拿不到就大声（表没有/
 * 点不够/值不是数）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { trendSeries, trendGeometry, numOf } from './state-trend.js';
import { renderChalk, CHALK_DIR } from './chalk.js';
import { STATE_TABLE_TAG } from './state-table.js';

const run = promisify(execFile);
const T = (v, extra = '') => `## 状态\n\n| 键 | 值 |\n| --- | --- |\n| 好感度 | ${v} |\n| 体力 | ${extra || '8/10'} |\n| 地点 | 教室 |`;

let ws;
const REL = `${CHALK_DIR}/20260830-120000-状态.md`;
async function commitTable(v, extra) {
  await fs.writeFile(path.join(ws, REL), renderChalk({ body: T(v, extra), by: 'agent', tag: STATE_TABLE_TAG }));
  await run('git', ['add', '-A'], { cwd: ws });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `beat ${v}`, '--allow-empty'], { cwd: ws });
}

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-trend-'));
  await fs.mkdir(path.join(ws, CHALK_DIR), { recursive: true });
  await run('git', ['init', '-q'], { cwd: ws });
  await commitTable(1);
  await commitTable(3);
  await commitTable(3);     // 横盘也是一点
  await commitTable(7, '6/10');
});

describe('trendSeries', () => {
  it('⭐ 每 commit 一点、旧→新；盘上现值（未 commit 的改动）收尾', async () => {
    const r = await trendSeries(ws, '好感度');
    expect(r.ok).toBe(true);
    expect(r.points).toEqual([1, 3, 3, 7]);
    // 盘上改到 9 还没 commit → 序列尾巴跟上
    await fs.writeFile(path.join(ws, REL), renderChalk({ body: T(9), by: 'agent', tag: STATE_TABLE_TAG }));
    const r2 = await trendSeries(ws, '好感度');
    expect(r2.points).toEqual([1, 3, 3, 7, 9]);
    await fs.writeFile(path.join(ws, REL), renderChalk({ body: T(7, '6/10'), by: 'agent', tag: STATE_TABLE_TAG }));
  });

  it('「8/10」这类值抠出 8；纯文字键大声拒', async () => {
    const r = await trendSeries(ws, '体力');
    expect(r.ok).toBe(true);
    expect(r.points[r.points.length - 1]).toBe(6);
    const bad = await trendSeries(ws, '地点');
    expect(bad.ok).toBe(false);
    expect(bad.why).toMatch(/抠不出数字/);
  });

  it('⛔ 键不存在 / 表不存在，都大声', async () => {
    expect((await trendSeries(ws, '不存在')).why).toMatch(/没有「不存在」/);
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-trend2-'));
    expect((await trendSeries(empty, 'x')).why).toMatch(/还没有状态表/);
  });
});

describe('trendGeometry', () => {
  it('点映射进画框、末点带小圈、横盘（全同值）不除零', () => {
    const g = trendGeometry([2, 5, 3, 9]);
    expect(g.min).toBe(2); expect(g.max).toBe(9);
    expect(g.lineD.startsWith('M')).toBe(true);
    expect((g.lineD.match(/L/g) || []).length).toBe(3);
    const flat = trendGeometry([4, 4, 4]);
    expect(flat.lineD).not.toMatch(/NaN/);
  });
});
