import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import db from '../../engine/runs/store.js';
import { decideRelay, newUserText, _resetSeen } from './gates.js';

function makeUser({ role = 'user', plan = 'basic', lifetime = null, daily = null } = {}) {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)')
    .run(id, id, 'x', role);
  return { id, username: id, role, plan, disabled: false, lifetimeCostLimitUsd: lifetime, dailyCostLimitUsd: daily };
}

/** 未知 model 名 → resolveModelRoute 判为订阅通路（走站主账号那条） */
const SUBSCRIPTION_BODY = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: '你好' }] };
const pass = async () => ({ ok: true, level: 'strict' });

beforeEach(() => { _resetSeen(); });

describe('newUserText：只取这一发新出现的用户原创内容', () => {
  it('字符串 content 直接取', () => {
    expect(newUserText({ messages: [{ role: 'user', content: '  写首诗  ' }] })).toBe('写首诗');
  });
  it('数组 content 只取 text 块，tool_result 与图片不算用户写的', () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'tool_result', content: '工具返回的东西' },
      { type: 'text', text: '第一段' },
      { type: 'image', source: {} },
      { type: 'text', text: '第二段' },
    ] }] };
    expect(newUserText(body)).toBe('第一段\n第二段');
  });
  it('取最后一条 user 消息，不是第一条', () => {
    const body = { messages: [
      { role: 'user', content: '旧的' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '新的' },
    ] };
    expect(newUserText(body)).toBe('新的');
  });
  it('没有 user 消息 / 形状不对 → 空串', () => {
    expect(newUserText({ messages: [{ role: 'assistant', content: 'x' }] })).toBe('');
    expect(newUserText({})).toBe('');
    expect(newUserText(null)).toBe('');
  });
});

describe('闸 1：档位', () => {
  it('basic 档走订阅模型 → 403', async () => {
    const r = await decideRelay({ user: makeUser({ plan: 'basic' }), body: SUBSCRIPTION_BODY }, { moderate: pass });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.code).toBe('SUBSCRIPTION_REQUIRED');
  });
  it('pro 档过得去这一闸', async () => {
    const r = await decideRelay({ user: makeUser({ plan: 'pro' }), body: SUBSCRIPTION_BODY }, { moderate: pass });
    expect(r.ok).toBe(true);
  });
});

describe('闸 2：额度', () => {
  it('总额度用完 → 402，且不打外审（顺序：贵的闸在后）', async () => {
    const moderate = vi.fn(pass);
    const user = makeUser({ plan: 'pro', lifetime: 0 });
    const r = await decideRelay({ user, body: SUBSCRIPTION_BODY }, { moderate });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(r.code).toBe('QUOTA_EXCEEDED');
    expect(moderate).not.toHaveBeenCalled();
  });
  it('admin 不受额度限制', async () => {
    const r = await decideRelay({ user: makeUser({ role: 'admin', lifetime: 0 }), body: SUBSCRIPTION_BODY }, { moderate: pass });
    expect(r.ok).toBe(true);
  });
});

describe('闸 3：外审', () => {
  // shouldModerate 没有 OPENAI_API_KEY 就整道跳过（既定的 fail-open）。
  // 这几条测的是"审起来之后怎么判"，所以先把前提装上。
  beforeEach(() => { process.env.OPENAI_API_KEY = 'test-key-not-used-真调用被注入替换了'; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; });

  it('判定拦截 → 403 CONTENT_BLOCKED（认的是 ok:false，不是 blocked）', async () => {
    const moderate = async () => ({ ok: false, level: 'strict', category: 'weapons', severity: 'normal', reason: '不行' });
    const r = await decideRelay({ user: makeUser({ plan: 'pro' }), body: SUBSCRIPTION_BODY }, { moderate });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.code).toBe('CONTENT_BLOCKED');
    expect(r.message).toBe('不行');
  });

  it('同一段文本第二次不再打外审（去重）', async () => {
    const moderate = vi.fn(pass);
    const user = makeUser({ plan: 'pro' });
    await decideRelay({ user, body: SUBSCRIPTION_BODY }, { moderate });
    await decideRelay({ user, body: SUBSCRIPTION_BODY }, { moderate });
    expect(moderate).toHaveBeenCalledTimes(1);
  });

  it('去重按人分：换个人要重新审', async () => {
    const moderate = vi.fn(pass);
    await decideRelay({ user: makeUser({ plan: 'pro' }), body: SUBSCRIPTION_BODY }, { moderate });
    await decideRelay({ user: makeUser({ plan: 'pro' }), body: SUBSCRIPTION_BODY }, { moderate });
    expect(moderate).toHaveBeenCalledTimes(2);
  });

  it('fail-open 那一发放行，但不记指纹：服务恢复后要重新审', async () => {
    const moderate = vi.fn(async () => ({ ok: true, level: 'strict', failedOpen: true }));
    const user = makeUser({ plan: 'pro' });
    expect((await decideRelay({ user, body: SUBSCRIPTION_BODY }, { moderate })).ok).toBe(true);
    await decideRelay({ user, body: SUBSCRIPTION_BODY }, { moderate });
    expect(moderate).toHaveBeenCalledTimes(2);   // 没被去重表挡住
  });

  it('admin 的外审默认档是 off，压根不打', async () => {
    const moderate = vi.fn(pass);
    await decideRelay({ user: makeUser({ role: 'admin' }), body: SUBSCRIPTION_BODY }, { moderate });
    expect(moderate).not.toHaveBeenCalled();
  });

  it('没配 OPENAI_API_KEY 时整道外审安静地不存在（既定 fail-open，但值得知道）', async () => {
    delete process.env.OPENAI_API_KEY;
    const moderate = vi.fn(pass);
    const r = await decideRelay({ user: makeUser({ plan: 'pro' }), body: SUBSCRIPTION_BODY }, { moderate });
    expect(r.ok).toBe(true);
    expect(r.moderated).toBe(false);
    expect(moderate).not.toHaveBeenCalled();
  });

  it('总闸 NODESIGN_MODERATION=off 时也不审', async () => {
    process.env.NODESIGN_MODERATION = 'off';
    const moderate = vi.fn(pass);
    await decideRelay({ user: makeUser({ plan: 'pro' }), body: SUBSCRIPTION_BODY }, { moderate });
    expect(moderate).not.toHaveBeenCalled();
    delete process.env.NODESIGN_MODERATION;
  });
});
