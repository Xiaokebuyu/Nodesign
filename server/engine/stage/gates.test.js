/**
 * 演出侧的两道闸：额度 + 外审（09-07）。
 *
 * 判定本身是 lib/quota.js 与 lib/moderation.js 的事，这里只钉这两道闸自己的口径：
 * 谁受管、拦下要抛得对、留证要落、分类器挂了必须放行。
 * ⚠️ 注入的假分类器一律按真口径返回 `ok`，不造 blocked 字段 —— 拿一个真实世界不存在的
 * 形状去测，测出来的绿是假绿（gates.js 那次就是把 ok 写成 blocked，闸静默永不触发）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-used';   // shouldModerate 的前置开关
delete process.env.NODESIGN_MODERATION;                                          // 全站总闸别关着

const { assertSayAllowed } = await import('./gates.js');
const { listFlags } = await import('../../lib/moderation.js');
const db = (await import('../runs/store.js')).default;

// 订阅行 = Claude 系列走订阅旋钮；API 行（GLM / DeepSeek 那些）走另一个，默认 off
const CLAUDE = 'claude-sonnet-5[1m]';
const API_ROW = 'deepseek-v4-flash-vision';
const strictUser = { id: 'u-strict', tier: 'basic', moderation_level: 'strict' };

const pass = vi.fn(async () => ({ ok: true }));
const block = vi.fn(async () => ({ ok: false, category: 'sexual/minors', severity: 'critical', reason: '未成年人' }));
const dead = vi.fn(async () => ({ ok: true, failedOpen: true }));

beforeEach(() => { pass.mockClear(); block.mockClear(); dead.mockClear(); });

const say = (over = {}, deps) => assertSayAllowed(
  { user: strictUser, model: CLAUDE, text: '我推开公会的门', projectId: 'p1', ...over }, deps,
);

describe('档位说了算', () => {
  it('订阅行 + strict：真去问分类器', async () => {
    await expect(say({}, { moderate: pass })).resolves.toMatchObject({ moderated: true });
    expect(pass).toHaveBeenCalledOnce();
  });

  it('非 Claude 的行按 API 旋钮，默认 off：一次都不问', async () => {
    await expect(say({ model: API_ROW }, { moderate: pass })).resolves.toMatchObject({ moderated: false });
    expect(pass).not.toHaveBeenCalled();
  });

  it('没有人（拿不到账号）不审', async () => {
    await say({ user: null }, { moderate: pass });
    expect(pass).not.toHaveBeenCalled();
  });

  it('空话不审：拿空串去问分类器只是白花一次调用', async () => {
    await say({ text: '   ' }, { moderate: pass });
    expect(pass).not.toHaveBeenCalled();
  });
});

describe('拦下', () => {
  it('抛 451 + MODERATION_BLOCKED，话不会被送上台', async () => {
    await expect(say({}, { moderate: block })).rejects.toMatchObject({ status: 451, code: 'MODERATION_BLOCKED' });
  });

  it('留证：flag 落库，摘录进得去', async () => {
    const uid = `u-eviden-${Date.now()}`;
    await expect(
      assertSayAllowed({ user: { ...strictUser, id: uid }, model: CLAUDE, text: '这句话要被记下来', projectId: 'p9' }, { moderate: block }),
    ).rejects.toThrow();
    const mine = listFlags({ userId: uid });
    expect(mine).toHaveLength(1);
    expect(mine[0].excerpt).toContain('这句话要被记下来');
    expect(mine[0].category).toBe('sexual/minors');
  });
});

describe('fail-open 是纪律不是意外', () => {
  it('分类器挂了照样放行（这道闸的价值是留证加封号，不是绝对拦截）', async () => {
    await expect(say({}, { moderate: dead })).resolves.toMatchObject({ moderated: true });   // 问过了，而且没抛
  });

  it('分类器返回个没见过的形状也放行，不是拦下', async () => {
    await expect(say({}, { moderate: async () => ({}) })).resolves.toBeTruthy();
  });
});

describe('额度闸（09-07 补：以前这条路上只有账没有闸）', () => {
  // 直接插用户：createUser 要走密码哈希与用户名校验，测的不是那些
  const mkUser = (over = {}) => {
    const id = 'u_q' + Math.random().toString(36).slice(2, 8);
    db.prepare('INSERT INTO users (id, username, password_hash, role, disabled, daily_cost_limit_usd) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, id, 'x', over.role || 'user', over.limit ?? 5);
    return { id, tier: 'basic', role: over.role || 'user', dailyCostLimitUsd: over.limit ?? 5, ...over };
  };

  it('额度用完：抛 429 + QUOTA_EXCEEDED，外审那一发根本不打', async () => {
    const user = mkUser({ limit: 0 });   // 上限 0 = 已经超了
    await expect(
      assertSayAllowed({ user, model: API_ROW, text: '再来一句', byPlayer: true }, { moderate: pass }),
    ).rejects.toMatchObject({ status: 429, code: 'QUOTA_EXCEEDED' });
    expect(pass).not.toHaveBeenCalled();   // 先额度后外审：省掉那一次网络
  });

  it('额度没用完：过', async () => {
    await expect(
      assertSayAllowed({ user: mkUser(), model: API_ROW, text: '推开门' }, { moderate: pass }),
    ).resolves.toMatchObject({ quota: true });
  });

  it('admin 不限额', async () => {
    await expect(
      assertSayAllowed({ user: mkUser({ role: 'admin', limit: 0 }), model: API_ROW, text: '推开门' }, { moderate: pass }),
    ).resolves.toBeTruthy();
  });

  it('免费行不看金额（按金额算对 $0 的行没有意义，跟 turn.js 同一条判据）', async () => {
    await expect(
      assertSayAllowed({ user: mkUser({ limit: 0 }), model: 'minimax-m3', text: '推开门' }, { moderate: pass }),
    ).resolves.toMatchObject({ quota: false });
  });

  it('机器合成的开场指令照样要过额度（它一样要付钱），但不过外审', async () => {
    const user = mkUser({ limit: 0 });
    await expect(
      assertSayAllowed({ user, model: API_ROW, text: '开场指令', byPlayer: false }, { moderate: pass }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(pass).not.toHaveBeenCalled();
  });
});
