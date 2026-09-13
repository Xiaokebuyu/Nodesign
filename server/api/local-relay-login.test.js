/**
 * 本地版「在浏览器中登录」的本机半（09-13 auth-v2 第四批）：发起 / 回调 / 取消 / 令牌失效收口。
 * 站点是本文件里起的假 relay：/token 真的按 S256 核 verifier，与站点侧 hosted/auth/desktop-auth.js 同一口径。
 * 攻击用例：外站打本机回调（state 对不上 / 塞假码）不许打断正在等的登录；回调页不许把站点回的内容当 HTML 执行。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

vi.mock('../runtime/capabilities.js', () => ({ probeCapabilities: async () => {}, capabilitySnapshot: () => [] }));

// 假站点：记下确认页该签的码（测试里直接登记），/token 核 verifier
const issued = new Map();   // code → challenge
const seen = [];
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/api/relay/token') {
      const j = JSON.parse(b || '{}');
      const challenge = issued.get(j.code);
      issued.delete(j.code);
      const ok = challenge && crypto.createHash('sha256').update(j.verifier || '').digest('base64url') === challenge;
      if (j.code === 'evil') return send(400, { type: 'error', error: { type: 'invalid_request_error', message: '<img src=x onerror=alert(1)>' }, code: 'INVALID_CODE' });
      if (!ok) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: '授权已失效' }, code: 'INVALID_CODE' });
      return send(201, { token: `ndk_${crypto.randomBytes(3).toString('hex')}.s`, device: { id: 'd1', label: 'x' }, user: { id: 'u1', username: 'alice', tier: 'basic' } });
    }
    if (req.url === '/api/relay/whoami') return send(200, { user: { id: 'u1', username: 'alice', tier: 'basic' }, quota: { kind: 'daily', used: 0, limit: 5 } });
    if (req.url === '/api/relay/models') return send(200, { models: [] });
    if (req.url === '/api/relay/logout') return send(200, { ok: true });
    send(404, {});
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-browser-login-'));
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = dataDir;
process.env.NODESIGN_RELAY_URL = `http://127.0.0.1:${fake.address().port}`;
delete process.env.NODESIGN_RELAY_TOKEN;

const { default: loginRouter, handleRelayTokenInvalid, _resetBrowserLogins } = await import('./local-relay-login.js');
const { relayConfig } = await import('../runtime/relay-client.js');

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/local/relay', loginRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => { _resetBrowserLogins(); issued.clear(); seen.length = 0; delete process.env.NODESIGN_RELAY_TOKEN; });

async function start() {
  const r = await fetch(`${base}/api/local/relay/browser-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(r.status).toBe(201);
  const j = await r.json();
  const u = new URL(j.authorizeUrl);
  return { state: j.state, url: u, challenge: u.searchParams.get('challenge') };
}
const status = async (state) => (await fetch(`${base}/api/local/relay/browser-login/${state}`)).json();
const callback = (q) => fetch(`${base}/api/local/relay/callback?${new URLSearchParams(q)}`);
/** 模拟站点确认页点了「允许」：给这个 challenge 登记一枚码 */
const allow = (challenge) => { const code = crypto.randomBytes(16).toString('base64url'); issued.set(code, challenge); return code; };

describe('发起', () => {
  it('确认页地址带本机端口、state、S256 challenge、设备名；verifier 不出本机', async () => {
    const { state, url, challenge } = await start();
    expect(url.pathname).toBe('/desktop-auth');
    expect(url.searchParams.get('port')).toBe(String(server.address().port));
    expect(url.searchParams.get('state')).toBe(state);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('device')).toBe(os.hostname().slice(0, 60));
    expect(await status(state)).toEqual({ status: 'pending', error: null });
  });

  it('只收 application/json：跨站的简单请求发不起来', async () => {
    const r = await fetch(`${base}/api/local/relay/browser-login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(415);
  });
});

describe('回调', () => {
  it('正常路径：换到令牌写进 .env，状态 done，别的等待作废；回调页禁嵌入、不带 referrer', async () => {
    const a = await start();
    const b = await start();
    const r = await callback({ code: allow(a.challenge), state: a.state });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await r.text()).toContain('已登录 NoDesign');
    expect(await status(a.state)).toMatchObject({ status: 'done' });
    expect(await status(b.state)).toMatchObject({ status: 'cancelled' });
    expect(relayConfig()?.token).toMatch(/^ndk_/);
    expect(fs.readFileSync(path.join(dataDir, '.env'), 'utf8')).toContain(`NODESIGN_RELAY_TOKEN=${relayConfig().token}`);
    // 同一次回调再来一遍（浏览器刷新）：不再换令牌
    const before = seen.filter((s) => s.url === '/api/relay/token').length;
    expect((await callback({ code: 'again', state: a.state })).status).toBe(400);
    expect(seen.filter((s) => s.url === '/api/relay/token').length).toBe(before);
  });

  it('外站打回调：state 对不上回 400 页，不动正在等的登录，也不去站点换码', async () => {
    const a = await start();
    for (const q of [{ code: 'x', state: 'guess' }, { code: 'x' }, { error: 'access_denied', state: 'guess' }]) {
      expect((await callback(q)).status).toBe(400);
    }
    expect(seen.some((s) => s.url === '/api/relay/token')).toBe(false);
    expect(await status(a.state)).toMatchObject({ status: 'pending' });
    // 之后真的那次照样能完成
    expect((await callback({ code: allow(a.challenge), state: a.state })).status).toBe(200);
  });

  it('码是假的：这次失败、原因进状态，但继续等（真的那次还可能在后面到）；站点回的文字在页面上被转义', async () => {
    const a = await start();
    const r = await callback({ code: 'evil', state: a.state });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(await status(a.state)).toMatchObject({ status: 'pending', error: '<img src=x onerror=alert(1)>' });
    expect((await callback({ code: allow(a.challenge), state: a.state })).status).toBe(200);
  });

  it('确认页点了取消（error=access_denied）或应用里点取消：状态 cancelled，之后的回调无效', async () => {
    const a = await start();
    expect((await callback({ error: 'access_denied', state: a.state })).status).toBe(200);
    expect(await status(a.state)).toMatchObject({ status: 'cancelled' });
    const b = await start();
    await fetch(`${base}/api/local/relay/browser-login/${b.state}`, { method: 'DELETE' });
    expect((await callback({ code: allow(b.challenge), state: b.state })).status).toBe(400);
    expect(relayConfig()).toBeNull();
  });

  it('不认识的 state 查状态：expired', async () => {
    expect(await status('nope')).toMatchObject({ status: 'expired' });
  });
});

describe('令牌失效收口', () => {
  it('失效的正是当前令牌：清掉；已经换了新令牌：不动', async () => {
    fs.writeFileSync(path.join(dataDir, '.env'), 'NODESIGN_RELAY_TOKEN=ndk_new.s\n');
    process.env.NODESIGN_RELAY_TOKEN = 'ndk_new.s';
    expect(await handleRelayTokenInvalid('ndk_old.s')).toBe(false);
    expect(relayConfig()?.token).toBe('ndk_new.s');
    expect(await handleRelayTokenInvalid('ndk_new.s')).toBe(true);
    expect(relayConfig()).toBeNull();
    expect(fs.readFileSync(path.join(dataDir, '.env'), 'utf8')).not.toContain('NODESIGN_RELAY_TOKEN');
  });
});
