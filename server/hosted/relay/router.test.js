/**
 * relay HTTP 层的端到端：真 express、真设备令牌、真会话登记、真判决、真账本；上游是本文件里起的假 Anthropic。
 * 模型表通过 NODESIGN_MODELS_CONFIG 注入一条指向假上游的行（要在 model-context 加载**之前**设好，所以下面全是动态 import）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

// ── 假 Anthropic 上游：记下收到的请求，回一段带 usage 的 SSE ──
const upstreamSeen = [];
let upstreamMode = 'sse';   // 'sse' | 'json' | '500'
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    upstreamSeen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    if (upstreamMode === '500') { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('boom'); return; }
    if (upstreamMode === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 1 } } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 500 } })}\n\n`);
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

// 模型表注入：一条 anthropic 协议的假行，价目 input $1 / output $2 / cacheRead $0.1 每 M
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-router-'));
const cfgPath = path.join(cfgDir, 'models.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  upstreams: { fakeanthro: { label: '假上游', baseUrl: upstreamUrl, protocol: 'anthropic', authStyle: 'x-api-key', key: 'fake-upstream-key', countTokens: false } },
  models: [{ id: 'fake-anthro', label: 'Fake', desc: 'test', window: 200000, upstream: 'fakeanthro', wireModel: 'fake-wire-model', thinking: 'strip', prices: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, fastModel: 'fake-anthro', brand: 'custom' }],
}));
process.env.NODESIGN_MODELS_CONFIG = cfgPath;
process.env.OPENAI_API_KEY = 'test-key-外审被注入替换了';

const db = (await import('../../engine/runs/store.js')).default;
const { mintDevice } = await import('./devices.js');
const { hashPassword } = await import('../users-write.js');
const { createRelayRouter } = await import('./router.js');
const { _resetRelaySessions } = await import('./sessions.js');
const { _resetSeen } = await import('./gates.js');
const { installRelayUsageSource, _resetInstalled } = await import('./usage.js');
const { _resetUsageSources, checkQuota } = await import('../../lib/quota.js');
const { resolveModelRoute } = await import('../../engine/agent/model-context.js');

function makeUser({ role = 'user', plan = 'basic', daily = null, lifetime = null } = {}) {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, plan, disabled, daily_cost_limit_usd, lifetime_cost_limit_usd) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, id, 'x', role, plan, daily, lifetime);
  return { id, username: id, role, plan, disabled: false, dailyCostLimitUsd: daily, lifetimeCostLimitUsd: lifetime };
}

const moderate = vi.fn(async () => ({ ok: true }));
const subForward = vi.fn((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"sub":true}'); });

let server; let base;
beforeAll(async () => {
  _resetUsageSources(); _resetInstalled(); installRelayUsageSource();
  const app = express();
  app.use('/api/relay', createRelayRouter({ moderate, forwardSub: subForward }));
  app.use(express.json());
  app.use('/api', (_req, res) => res.status(401).json({ error: '登录墙' }));   // 模拟后面的 cookie 登录墙
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/relay`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  fs.rmSync(cfgDir, { recursive: true, force: true });
  delete process.env.NODESIGN_MODELS_CONFIG;
  delete process.env.OPENAI_API_KEY;
});
beforeEach(() => { _resetRelaySessions(); _resetSeen(); moderate.mockClear(); subForward.mockClear(); upstreamSeen.length = 0; upstreamMode = 'sse'; });

const api = (token, p, init = {}) => fetch(base + p, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
const openSession = async (token, appModel, sid = 'sid-' + crypto.randomBytes(6).toString('hex')) => {
  const r = await api(token, '/sessions', { method: 'POST', body: JSON.stringify({ sid, appModel }) });
  return { r, sid };
};
const infer = (token, sid, body, sub = '') => api(token, `/__nd/${sid}/v1/messages${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const BODY = { model: 'claude-sonnet-4-6[1m]', max_tokens: 100, stream: true, messages: [{ role: 'user', content: '写首诗' }] };
const usageRows = (userId) => db.prepare('SELECT * FROM relay_usage WHERE user_id = ? ORDER BY id').all(userId);

describe('门口', () => {
  it('没令牌 / 假令牌 → 401，Anthropic 错误形状', async () => {
    const r1 = await fetch(base + '/whoami');
    expect(r1.status).toBe(401);
    const r2 = await api('ndk_nope.nope', '/whoami');
    expect(r2.status).toBe(401);
    const j = await r2.json();
    expect(j.type).toBe('error');
    expect(j.code).toBe('DEVICE_TOKEN_INVALID');
  });
  it('whoami 报档位和额度', async () => {
    const user = makeUser({ plan: 'basic', daily: 5 });
    const { token } = mintDevice({ userId: user.id, label: 'pc' });
    const j = await (await api(token, '/whoami')).json();
    expect(j.user.tier).toBe('basic');
    expect(j.capabilities.subscription).toBe(false);
    expect(j.quota).toEqual({ kind: 'daily', used: 0, limit: 5 });
  });
  it('relay 下的未知路径由 relay 自己 404，不漏到登录墙', async () => {
    const user = makeUser();
    const { token } = mintDevice({ userId: user.id });
    const r = await api(token, '/nope');
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('NOT_FOUND');
  });
});

describe('登录换令牌 / 退出', () => {
  const login = (body) => fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('对的账号密码 → 201 带令牌，令牌立刻能用；错密码 401 不带令牌', async () => {
    const user = makeUser({ plan: 'basic' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('pw-right-1'), user.id);
    const bad = await login({ username: user.username, password: 'nope' });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe('BAD_CREDENTIALS');
    const r = await login({ username: user.username, password: 'pw-right-1', label: '  台式机 ' });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.token.startsWith('ndk_')).toBe(true);
    expect(j.device.label).toBe('台式机');
    expect(j.user.tier).toBe('basic');
    const who = await api(j.token, '/whoami');
    expect(who.status).toBe(200);
    // 退出 = 吊销这一枚
    expect((await api(j.token, '/logout', { method: 'POST' })).status).toBe(200);
    expect((await api(j.token, '/whoami')).status).toBe(401);
  });
  it('停用的账号登不进', async () => {
    const user = makeUser();
    db.prepare('UPDATE users SET password_hash = ?, disabled = 1 WHERE id = ?').run(hashPassword('pw-right-2'), user.id);
    expect((await login({ username: user.username, password: 'pw-right-2' })).status).toBe(401);
  });
});

describe('目录', () => {
  it('basic 拿到假行（不锁）和订阅行（锁着带原因），只报 id/locked/lockReason', async () => {
    const user = makeUser({ plan: 'basic' });
    const { token } = mintDevice({ userId: user.id });
    const j = await (await api(token, '/models')).json();
    const fake = j.models.find((m) => m.id === 'fake-anthro');
    expect(fake).toEqual({ id: 'fake-anthro', locked: false });
    const sonnet = j.models.find((m) => m.id === 'claude-sonnet-5[1m]');
    expect(sonnet.locked).toBe(true);
    expect(typeof sonnet.lockReason).toBe('string');
  });
  it('pro：订阅行不锁', async () => {
    const user = makeUser({ plan: 'pro' });
    const { token } = mintDevice({ userId: user.id });
    const j = await (await api(token, '/models')).json();
    expect(j.models.find((m) => m.id === 'claude-sonnet-5[1m]').locked).toBe(false);
  });
});

describe('会话登记', () => {
  it('basic 登记订阅模型 → 403 当场拒', async () => {
    const user = makeUser({ plan: 'basic' });
    const { token } = mintDevice({ userId: user.id });
    const { r } = await openSession(token, 'claude-sonnet-5[1m]');
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('SUBSCRIPTION_REQUIRED');
  });
  it('API 行 → 201，mode=api；没登记就推理 → 400；别人的 sid → 403', async () => {
    const a = makeUser(); const b = makeUser();
    const ta = mintDevice({ userId: a.id }).token; const tb = mintDevice({ userId: b.id }).token;
    const { r, sid } = await openSession(ta, 'fake-anthro');
    expect(r.status).toBe(201);
    expect((await r.json()).mode).toBe('api');
    expect((await infer(ta, 'sid-never-opened', BODY)).status).toBe(400);
    const foreign = await infer(tb, sid, BODY);
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).code).toBe('SID_FOREIGN');
  });
});

describe('API 腿：转发 + 记账', () => {
  it('SSE 逐字节到客户端；钥匙换成上游的；账按表价记（1000 in + 500 out + 2000 cacheRead）', async () => {
    const user = makeUser({ plan: 'basic', daily: 5 });
    const { token } = mintDevice({ userId: user.id });
    const { sid } = await openSession(token, 'fake-anthro');
    const r = await infer(token, sid, BODY);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('message_start');
    expect(text).toContain('你好');
    // 上游看到的：钥匙是上游的不是设备令牌；model 已还原成 wireModel
    expect(upstreamSeen).toHaveLength(1);
    expect(upstreamSeen[0].headers['x-api-key']).toBe('fake-upstream-key');
    expect(upstreamSeen[0].headers.authorization).toBeUndefined();
    expect(upstreamSeen[0].body.model).toBe('fake-wire-model');
    // 账：流结束后异步落库，等一拍
    await vi.waitFor(() => expect(usageRows(user.id)).toHaveLength(1));
    const row = usageRows(user.id)[0];
    expect(row.model).toBe('fake-anthro');
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(500);
    expect(row.cache_read).toBe(2000);
    expect(row.cost_usd).toBeCloseTo((1000 * 1 + 500 * 2 + 2000 * 0.1) / 1e6, 12);
    // 额度闸读得到这笔
    expect(checkQuota(user).used).toBeCloseTo(row.cost_usd, 12);
  });
  it('非流式 JSON 响应同样记账', async () => {
    upstreamMode = 'json';
    const user = makeUser();
    const { token } = mintDevice({ userId: user.id });
    const { sid } = await openSession(token, 'fake-anthro');
    const r = await infer(token, sid, { ...BODY, stream: false });
    expect(r.status).toBe(200);
    expect((await r.json()).usage.input_tokens).toBe(1000);
    await vi.waitFor(() => expect(usageRows(user.id)).toHaveLength(1));
    expect(usageRows(user.id)[0].cost_usd).toBeCloseTo((1000 + 1000) / 1e6, 12);
  });
  it('上游 5xx：状态透传、不记账', async () => {
    upstreamMode = '500';
    const user = makeUser();
    const { token } = mintDevice({ userId: user.id });
    const { sid } = await openSession(token, 'fake-anthro');
    const r = await infer(token, sid, BODY);
    expect(r.status).toBe(500);
    await new Promise((res) => setTimeout(res, 50));
    expect(usageRows(user.id)).toHaveLength(0);
  });
  it('额度用完 → 402，上游一次都没碰', async () => {
    const user = makeUser({ lifetime: 0 });
    const { token } = mintDevice({ userId: user.id });
    const { sid } = await openSession(token, 'fake-anthro');
    const r = await infer(token, sid, BODY);
    expect(r.status).toBe(402);
    expect((await r.json()).code).toBe('QUOTA_EXCEEDED');
    expect(upstreamSeen).toHaveLength(0);
  });
  it('记账之后额度真的会关上（第二发被 402）', async () => {
    // 日额度设成比一发的钱还小：第一发放行并记账，第二发就该拦
    const oneShot = (1000 * 1 + 500 * 2 + 2000 * 0.1) / 1e6;
    const user = makeUser({ daily: oneShot / 2 });
    const { token } = mintDevice({ userId: user.id });
    const { sid } = await openSession(token, 'fake-anthro');
    expect((await infer(token, sid, BODY)).status).toBe(200);
    await vi.waitFor(() => expect(usageRows(user.id)).toHaveLength(1));
    const r2 = await infer(token, sid, BODY);
    expect(r2.status).toBe(402);
    expect(upstreamSeen).toHaveLength(1);
  });
  it('外审拦下 → 403 CONTENT_BLOCKED，上游没碰；count_tokens 不过外审', async () => {
    const user = makeUser({ plan: 'basic' });
    db.prepare('UPDATE users SET moderation_level_api = ? WHERE id = ?').run('strict', user.id);
    const { token } = mintDevice({ userId: user.id });
    const { sid } = await openSession(token, 'fake-anthro');
    moderate.mockResolvedValueOnce({ ok: false, category: 'x', severity: 'normal', reason: '不行' });
    const r = await infer(token, sid, BODY);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('CONTENT_BLOCKED');
    expect(upstreamSeen).toHaveLength(0);
    moderate.mockClear();
    const ct = await infer(token, sid, { model: BODY.model, messages: BODY.messages }, '/count_tokens');
    expect(ct.status).toBe(200);   // 假上游 countTokens:false → 本地估算短路
    expect((await ct.json()).input_tokens).toBeGreaterThan(0);
    expect(moderate).not.toHaveBeenCalled();
  });
});

describe('订阅腿', () => {
  it('pro 登记订阅模型 → 201 mode=subscription，推理走订阅腿而不是入口', async () => {
    expect(resolveModelRoute('claude-sonnet-5[1m]').mode).toBe('subscription');
    const user = makeUser({ plan: 'pro' });
    const { token } = mintDevice({ userId: user.id });
    const { r, sid } = await openSession(token, 'claude-sonnet-5[1m]');
    expect(r.status).toBe(201);
    expect((await r.json()).mode).toBe('subscription');
    const res = await infer(token, sid, { ...BODY, model: 'claude-sonnet-5[1m]' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: true });
    expect(subForward).toHaveBeenCalledTimes(1);
    expect(upstreamSeen).toHaveLength(0);
  });
});
