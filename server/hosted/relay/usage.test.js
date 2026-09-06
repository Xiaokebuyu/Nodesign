import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import db from '../../engine/runs/store.js';
import { checkQuota, registerUsageSource, usedCostToday, usedCostTotal, _resetUsageSources } from '../../lib/quota.js';
import {
  recordRelayUsage, relayCostToday, relayCostTotal, installRelayUsageSource, _resetInstalled,
} from './usage.js';

function makeUser({ daily = null, lifetime = null, role = 'user' } = {}) {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)')
    .run(id, id, 'x', role);
  return { id, username: id, role, plan: 'basic', disabled: false, dailyCostLimitUsd: daily, lifetimeCostLimitUsd: lifetime };
}

beforeEach(() => { _resetUsageSources(); _resetInstalled(); });

describe('relay 账本', () => {
  it('记一发就能查到', () => {
    const u = makeUser();
    recordRelayUsage({ userId: u.id, model: 'x', costUsd: 1.25 });
    recordRelayUsage({ userId: u.id, model: 'x', costUsd: 0.75 });
    expect(relayCostToday(u.id)).toBeCloseTo(2, 6);
    expect(relayCostTotal(u.id)).toBeCloseTo(2, 6);
  });

  it('上游没报费用记 0，不估数', () => {
    const u = makeUser();
    expect(recordRelayUsage({ userId: u.id, costUsd: null })).toBe(0);
    expect(recordRelayUsage({ userId: u.id, costUsd: 'abc' })).toBe(0);
    expect(relayCostToday(u.id)).toBe(0);
  });

  it('昨天的不算进今天，但算进全史', () => {
    const u = makeUser();
    db.prepare("INSERT INTO relay_usage (user_id, cost_usd, created_at) VALUES (?, ?, datetime('now','-2 days'))")
      .run(u.id, 9);
    recordRelayUsage({ userId: u.id, costUsd: 1 });
    expect(relayCostToday(u.id)).toBeCloseTo(1, 6);
    expect(relayCostTotal(u.id)).toBeCloseTo(10, 6);
  });

  it('账记在各人名下，不串', () => {
    const a = makeUser(); const b = makeUser();
    recordRelayUsage({ userId: a.id, costUsd: 3 });
    expect(relayCostToday(a.id)).toBeCloseTo(3, 6);
    expect(relayCostToday(b.id)).toBe(0);
  });
});

describe('并进 quota（这是额度闸在桌面版能不能生效的那一环）', () => {
  it('不注册的话服务器看不见 relay 花的钱，额度闸形同虚设', () => {
    const u = makeUser({ daily: 5 });
    recordRelayUsage({ userId: u.id, costUsd: 100 });
    expect(usedCostToday(u.id)).toBe(0);          // 服务器上这人没有 runs
    expect(checkQuota(u).ok).toBe(true);          // ← 就是这个洞
  });

  it('注册之后 relay 的花费进同一本账，额度真的会拦', () => {
    const u = makeUser({ daily: 5 });
    installRelayUsageSource();
    recordRelayUsage({ userId: u.id, costUsd: 6 });
    expect(usedCostToday(u.id)).toBeCloseTo(6, 6);
    const q = checkQuota(u);
    expect(q.ok).toBe(false);
    expect(q.kind).toBe('daily');
  });

  it('终身额度口径也并进去', () => {
    const u = makeUser({ lifetime: 2 });
    installRelayUsageSource();
    recordRelayUsage({ userId: u.id, costUsd: 3 });
    expect(usedCostTotal(u.id)).toBeCloseTo(3, 6);
    expect(checkQuota(u).ok).toBe(false);
  });

  it('注册是幂等的：装两次不会把每一笔算两遍', () => {
    const u = makeUser({ daily: 5 });
    expect(installRelayUsageSource()).toBe(true);
    expect(installRelayUsageSource()).toBe(false);
    recordRelayUsage({ userId: u.id, costUsd: 2 });
    expect(usedCostToday(u.id)).toBeCloseTo(2, 6);   // 不是 4
  });

  it('某个账本读挂了不能把整个额度闸带崩，好的那本仍然算数', () => {
    const u = makeUser({ daily: 5 });
    registerUsageSource({
      today: () => { throw new Error('账本挂了'); },
      total: () => { throw new Error('账本挂了'); },
    });
    installRelayUsageSource();
    recordRelayUsage({ userId: u.id, costUsd: 6 });
    // 坏的那本按 0 计（额度偏松），但没把整条路带崩，好的那本照样进账
    expect(() => usedCostToday(u.id)).not.toThrow();
    expect(usedCostToday(u.id)).toBeCloseTo(6, 6);
    expect(checkQuota(u).ok).toBe(false);
  });

  it('registerUsageSource 拒收形状不对的账本（拼错不能静默变成不计数）', () => {
    expect(() => registerUsageSource({})).toThrow();
    expect(() => registerUsageSource({ today: () => 0 })).toThrow();
    expect(() => registerUsageSource(null)).toThrow();
  });
});
