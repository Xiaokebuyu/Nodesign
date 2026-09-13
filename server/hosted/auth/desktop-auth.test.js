/**
 * auth-v2 第四批：桌面版「在浏览器中登录」站点侧的端到端。
 * 确认页的「允许」（/api/me/desktop-auth/authorize）→ 授权码 → /api/relay/token 换设备令牌，
 * 每道校验都给一个它必须拦下的输入（方案 §10 攻击用例），再走一遍正常路径确认没有误拦。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

process.env.NODESIGN_MAIL_PROVIDER = 'memory';
process.env.NODESIGN_AUTH_SECRET = 'test-secret-desktop-auth';
process.env.NODESIGN_AUTH_PASSWORD = 'bootstrap-not-used';
delete process.env.NODESIGN_SESSION_COOKIE;

const db = (await import('../../engine/runs/store.js')).default;
const { installSessionBackend, _resetSessionBackend } = await import('../../auth/session.js');
const { authRouter, authGuard } = await import('../../auth/middleware.js');
const { hostedAuthRouter, _resetAuthThrottles } = await import('../auth-routes.js');
const { resolveRequest, logoutRequest, revokeUserSessions } = await import('./sessions-store.js');
const { createDesktopAuthRouter, parseDesktopAuthParams, mintDesktopCode, redeemDesktopCode, _resetDesktopCodes, CODE_TTL_MS } = await import('./desktop-auth.js');
const { createRelayRouter, _resetRelayTokenLimit } = await import('../relay/router.js');
const { mintDevice, verifyDeviceToken, revokeUserDevices } = await import('../relay/devices.js');
const { createUser } = await import('../users-write.js');
const { invalidateUserCache } = await import('../../auth/users-store.js');
const { mintInternalCookie } = await import('../../auth/internal-credentials.js');
const { sentMail } = await import('./mailer.js');

let server; let base;
beforeAll(async () => {
  installSessionBackend({ resolve: resolveRequest, logout: logoutRequest });
  const app = express();
  app.use('/api/relay', createRelayRouter());   // relay 在 express.json 之前（要原始 body），与生产挂载顺序一致
  app.use(express.json());
  app.use('/api/auth', hostedAuthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api', authGuard);
  app.use('/api/me/desktop-auth', createDesktopAuthRouter());
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  _resetSessionBackend();
  await new Promise((r) => server.close(r));
});
beforeEach(() => { _resetAuthThrottles(); _resetDesktopCodes(); _resetRelayTokenLimit(); });

let ipSeq = 0;
function call(path, { method = 'GET', body, rawBody, cookie, ip, origin } = {}) {
  ipSeq += 1;
  return fetch(base + path, {
    method,
    headers: {
      ...(body || rawBody ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      'cf-connecting-ip': ip || `10.4.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`,
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
}
const jsonOf = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const cookieHeader = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((kv) => !kv.endsWith('=')).join('; ');
const GOOD_PW = 'violet-tram-47';

let seq = 0;
async function signedInUser() {
  seq += 1;
  const email = `desk${seq}${Date.now().toString(36)}@example.com`;
  const user = createUser({ username: `desk${seq}${Date.now().toString(36)}`, password: GOOD_PW, email });
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  invalidateUserCache(user.id);
  const r = await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: GOOD_PW } });
  expect(r.status).toBe(200);
  return { user, email, cookie: cookieHeader(r) };
}

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function authorize(cookie, { port = 45678, device = 'LAPTOP-01', state = crypto.randomBytes(24).toString('base64url'), challenge, origin } = {}) {
  const r = await jsonOf(await call('/api/me/desktop-auth/authorize', { method: 'POST', cookie, origin, body: { port, state, challenge, device } }));
  return { ...r, state };
}
const codeOf = (redirect) => new URL(redirect).searchParams.get('code');

describe('确认页「允许」→ 授权码 → 换设备令牌', () => {
  it('正常路径：跳转地址只指向 127.0.0.1 的数字端口，换来的令牌可用、带设备名，发新设备通知', async () => {
    const { user, email, cookie } = await signedInUser();
    const { verifier, challenge } = pkce();
    const a = await authorize(cookie, { challenge, port: 51234 });
    expect(a.status).toBe(200);
    const url = new URL(a.body.redirect);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('http://127.0.0.1:51234/api/local/relay/callback');
    expect(url.searchParams.get('state')).toBe(a.state);

    const t = await jsonOf(await call('/api/relay/token', { method: 'POST', body: { code: codeOf(a.body.redirect), verifier } }));
    expect(t.status).toBe(201);
    expect(t.body.user.id).toBe(user.id);
    expect(t.body.device.label).toBe('LAPTOP-01');
    const hit = verifyDeviceToken(t.body.token);
    expect(hit.user.id).toBe(user.id);
    expect(sentMail.some((m) => m.to === email && /桌面设备/.test(m.subject))).toBe(true);
    // 通知正文不带用户可控的设备名（mail-templates 口径）
    expect(sentMail.filter((m) => m.to === email).every((m) => !m.text.includes('LAPTOP-01'))).toBe(true);
  });

  it('授权码只能用一次：重放 400', async () => {
    const { cookie } = await signedInUser();
    const { verifier, challenge } = pkce();
    const code = codeOf((await authorize(cookie, { challenge })).body.redirect);
    expect((await call('/api/relay/token', { method: 'POST', body: { code, verifier } })).status).toBe(201);
    expect((await jsonOf(await call('/api/relay/token', { method: 'POST', body: { code, verifier } }))).body.code).toBe('INVALID_CODE');
  });

  it('verifier 不对：400，而且这枚码随之作废（正确的 verifier 也换不出来）', async () => {
    const { cookie } = await signedInUser();
    const { verifier, challenge } = pkce();
    const code = codeOf((await authorize(cookie, { challenge })).body.redirect);
    expect((await call('/api/relay/token', { method: 'POST', body: { code, verifier: pkce().verifier } })).status).toBe(400);
    expect((await call('/api/relay/token', { method: 'POST', body: { code, verifier } })).status).toBe(400);
  });

  it('过期（60 秒）、签码之后账号全部下线、账号停用：码都作废', async () => {
    const { user } = await signedInUser();
    const { verifier, challenge } = pkce();
    const now = Date.now();
    const old = mintDesktopCode({ userId: user.id, challenge, label: null, now: now - CODE_TTL_MS - 1 });
    expect(redeemDesktopCode({ code: old, verifier, now }).ok).toBe(false);

    const beforeReset = mintDesktopCode({ userId: user.id, challenge, label: null, now: now - 1000 });
    revokeUserSessions(user.id, { now });
    expect(redeemDesktopCode({ code: beforeReset, verifier, now: now + 1 }).ok).toBe(false);

    const fresh = mintDesktopCode({ userId: user.id, challenge, label: null, now: now + 10 });
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    invalidateUserCache(user.id);
    expect(redeemDesktopCode({ code: fresh, verifier, now: now + 20 }).ok).toBe(false);
  });

  it('没登录 401；无头浏览器的内部凭证不能替用户签（409）；外站 Origin 403', async () => {
    const { user, cookie } = await signedInUser();
    const { challenge } = pkce();
    expect((await authorize('', { challenge })).status).toBe(401);
    const c = mintInternalCookie(user.id);
    expect((await authorize(`${c.name}=${c.value}`, { challenge })).status).toBe(409);
    expect((await authorize(cookie, { challenge, origin: 'https://evil.share.xiaobuyu.trade' })).status).toBe(403);
  });

  it('参数不合规一律 400：特权端口、非数字端口、坏 state、坏 challenge', async () => {
    const { cookie } = await signedInUser();
    const { challenge } = pkce();
    for (const bad of [{ port: 80 }, { port: '4001@evil.example' }, { port: 70000 }, { state: 'short' }, { challenge: 'abc' }]) {
      expect((await authorize(cookie, { challenge, ...bad })).status).toBe(400);
    }
  });

  it('设备名只当纯文本：去控制字符、截到 60 字', () => {
    const p = parseDesktopAuthParams({ port: '4001', state: 'a'.repeat(32), challenge: 'b'.repeat(43), device: `  PC\u0000\u202e${'x'.repeat(100)}\n` });
    expect(p.ok).toBe(true);
    expect(p.device).not.toMatch(/[\u0000\n]/);
    expect(p.device.length).toBeLessThanOrEqual(60);
  });

  it('在用设备满 10 台：确认页当场说；允许之后才满的，换令牌那一步也拦', async () => {
    const { user, cookie } = await signedInUser();
    const { verifier, challenge } = pkce();
    for (let i = 0; i < 9; i += 1) mintDevice({ userId: user.id, label: `d${i}` });
    const code = codeOf((await authorize(cookie, { challenge })).body.redirect);
    mintDevice({ userId: user.id, label: 'd9' });
    expect((await jsonOf(await call('/api/relay/token', { method: 'POST', body: { code, verifier } }))).body.code).toBe('TOO_MANY_DEVICES');
    expect((await authorize(cookie, { challenge })).body.code).toBe('TOO_MANY_DEVICES');
    revokeUserDevices(user.id);
  });

  it('/token 不要令牌但按 IP 限频；坏 JSON 400', async () => {
    expect((await call('/api/relay/token', { method: 'POST', rawBody: '{not json' })).status).toBe(400);
    const statuses = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await call('/api/relay/token', { method: 'POST', ip: '10.99.0.1', body: { code: 'x', verifier: 'y'.repeat(43) } })).status);
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it('账号密码的桌面登录（老路）同样发新设备通知', async () => {
    const { email } = await signedInUser();
    const before = sentMail.filter((m) => m.to === email && /桌面设备/.test(m.subject)).length;
    const r = await call('/api/relay/login', { method: 'POST', body: { username: email, password: GOOD_PW, label: 'OLD-CLIENT' } });
    expect(r.status).toBe(201);
    expect(sentMail.filter((m) => m.to === email && /桌面设备/.test(m.subject)).length).toBe(before + 1);
  });
});
