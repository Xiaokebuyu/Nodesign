import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import db from '../engine/runs/store.js';
import { dailyCostSeries, registerUsageSource, _resetUsageSources } from './quota.js';

function seed(userId, model, cost, daysAgo) {
  const runId = 'run_' + crypto.randomBytes(4).toString('hex');
  const at = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare("INSERT INTO runs (id, skill_id, brief, status, user_id, created_at) VALUES (?, 'x', 'x', 'succeeded', ?, ?)").run(runId, userId, at);
  db.prepare('INSERT INTO run_model_usage (run_id, model, cost_usd, created_at) VALUES (?, ?, ?, ?)').run(runId, model, cost, at);
}

beforeEach(() => _resetUsageSources());

describe('dailyCostSeries', () => {
  it('按天按模型汇总，窗口之外的不算，注册进来的账本 daily 一起进', () => {
    const u = 'u_' + crypto.randomBytes(3).toString('hex');
    seed(u, 'm1', 0.5, 0); seed(u, 'm1', 0.25, 0); seed(u, 'm2', 1, 3); seed(u, 'm1', 9, 40);
    registerUsageSource({ today: () => 0, total: () => 0, daily: () => [{ day: '2026-01-01', model: 'site-m', costUsd: 2 }] });
    const rows = dailyCostSeries(u, 30);
    const m1today = rows.filter((r) => r.model === 'm1').reduce((a, r) => a + r.costUsd, 0);
    expect(m1today).toBeCloseTo(0.75, 9);
    expect(rows.some((r) => r.model === 'm2' && r.costUsd === 1)).toBe(true);
    expect(rows.some((r) => r.costUsd === 9)).toBe(false);
    expect(rows.some((r) => r.model === 'site-m' && r.costUsd === 2)).toBe(true);
    for (const r of rows) expect(r.day).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
  it('账本没有 daily 也不炸', () => {
    registerUsageSource({ today: () => 0, total: () => 0 });
    expect(() => dailyCostSeries('nobody', 7)).not.toThrow();
    expect(dailyCostSeries('nobody', 7)).toEqual([]);
  });
});
