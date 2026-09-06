/**
 * 注册两条路（08-21）：带邀请码 → 订阅资格；不带 → 开放注册开着才放行、只免费模型。
 * 库走 vitest.server.config 里的 DB_PATH（临时库），不碰生产。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUser, createInvite, defaultInviteDailyUsd } from './users-write.js';
import { getUserById, updateUser, openRegistrationEnabled } from '../auth/users-store.js';
import { tierOf, can } from '../auth/tier.js';

const uniq = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
let savedFlag;
beforeAll(() => { savedFlag = process.env.NODESIGN_OPEN_REGISTRATION; });
afterAll(() => { if (savedFlag === undefined) delete process.env.NODESIGN_OPEN_REGISTRATION; else process.env.NODESIGN_OPEN_REGISTRATION = savedFlag; });

describe('registerUser', () => {
  it('开放注册关着：没邀请码拒（BAD_INVITE）', () => {
    delete process.env.NODESIGN_OPEN_REGISTRATION;
    expect(openRegistrationEnabled()).toBe(false);
    expect(() => registerUser({ username: uniq('u'), password: 'password123', inviteCode: '' })).toThrow(/邀请码无效/);
  });
  it('开放注册开着：没邀请码建号，落 basic 档（无订阅/发布资格；生图 08-21 深夜起开放、按张计价）', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const u = registerUser({ username: uniq('pub'), password: 'password123', inviteCode: '' });
    expect(u.plan).toBe('basic');
    expect(tierOf(u)).toBe('basic');
    expect(can(u, 'subscription')).toBe(false);
    expect(can(u, 'imageGen')).toBe(true);
    expect(can(u, 'publishSite')).toBe(false);
    expect(can(u, 'webSearch')).toBe(true);
    expect(u.inviteCode).toBeNull();
    expect(getUserById(u.id).plan).toBe('basic');
  });
  it('带邀请码：消耗码、落 pro 档、终身额度照抄（花费上限，不是档位）；admin 能手动降档', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const inv = createInvite({ maxUses: 1, grantLifetimeUsd: 3 });
    const u = registerUser({ username: uniq('inv'), password: 'password123', inviteCode: inv.code });
    expect(u.plan).toBe('pro');
    expect(can(u, 'subscription')).toBe(true);
    expect(can(u, 'publishSite')).toBe(true);     // 试用码（带终身额度）也是 pro：08-21 前这里被 lifetimeCostLimitUsd 当成试用号挡住
    expect(u.lifetimeCostLimitUsd).toBe(3);
    expect(() => registerUser({ username: uniq('inv2'), password: 'password123', inviteCode: inv.code })).toThrow(/已用完/);
    updateUser(u.id, { plan: 'basic' });
    expect(getUserById(u.id).plan).toBe('basic');
    expect(can(getUserById(u.id), 'subscription')).toBe(false);
    expect(() => updateUser(u.id, { plan: 'vip' })).toThrow(/plan/);
  });
  it('带邀请码：默认每日 $20（08-21 晚）；终身额度只在码上写了才有；env 可调，0 = 不写走全局默认', () => {
    process.env.NODESIGN_OPEN_REGISTRATION = '1';
    const saved = process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD;
    try {
      delete process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD;
      expect(defaultInviteDailyUsd({})).toBe(20);
      expect(defaultInviteDailyUsd({ NODESIGN_INVITE_DEFAULT_DAILY_USD: '35' })).toBe(35);
      expect(defaultInviteDailyUsd({ NODESIGN_INVITE_DEFAULT_DAILY_USD: '0' })).toBeNull();
      const inv = createInvite({ maxUses: 1 });
      const u = registerUser({ username: uniq('inv20'), password: 'password123', inviteCode: inv.code });
      expect(u.dailyCostLimitUsd).toBe(20);
      expect(u.lifetimeCostLimitUsd).toBeNull();
      expect(u.plan).toBe('pro');
      // 公开注册号（basic）：每天 $5 总额度（08-21 深夜：Go 付费行 + 生图按张计价都记这本账；Ox 免费行另按轮次闸）
      const pub = registerUser({ username: uniq('pub20'), password: 'password123', inviteCode: '' });
      expect(pub.dailyCostLimitUsd).toBe(5);
    } finally {
      if (saved === undefined) delete process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD; else process.env.NODESIGN_INVITE_DEFAULT_DAILY_USD = saved;
    }
  });
});
