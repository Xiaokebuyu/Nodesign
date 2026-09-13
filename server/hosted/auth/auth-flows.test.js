/**
 * auth-v2 端到端：真 express、真会话表、真验证码、memory 发信。每道闸都给一个它必须拦下的输入。
 * 装配形状照 server/index.js：hosted 登录路由 → 内核 /api/auth → authGuard → /api/me/account。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

process.env.NODESIGN_MAIL_PROVIDER = 'memory';
process.env.NODESIGN_OPEN_REGISTRATION = '1';
process.env.NODESIGN_AUTH_SECRET = 'test-secret-auth-v2';
process.env.NODESIGN_AUTH_PASSWORD = 'bootstrap-not-used';
delete process.env.NODESIGN_SESSION_COOKIE;

const db = (await import('../../engine/runs/store.js')).default;
const { installSessionBackend, mintToken, requestAuth, _resetSessionBackend } = await import('../../auth/session.js');
const { authRouter, authGuard } = await import('../../auth/middleware.js');
const { hostedAuthRouter, _resetAuthThrottles } = await import('../auth-routes.js');
const { resolveRequest, logoutRequest } = await import('./sessions-store.js');
const { default: accountRouter } = await import('./account-routes.js');
const { sentMail } = await import('./mailer.js');
const { mintDevice, verifyDeviceToken } = await import('../relay/devices.js');
const { getUserByEmail } = await import('../../auth/users-store.js');
const { createUser } = await import('../users-write.js');
const { mintInternalCookie } = await import('../../auth/internal-credentials.js');

let server; let base;
beforeAll(async () => {
  installSessionBackend({ resolve: resolveRequest, logout: logoutRequest });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', hostedAuthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api', authGuard);
  app.use('/api/me/account', accountRouter);
  app.get('/api/ping', (req, res) => res.json({ userId: req.user.id, kind: req.auth.kind }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  _resetSessionBackend();
  await new Promise((r) => server.close(r));
});
beforeEach(() => { _resetAuthThrottles(); });

let ipSeq = 0;
/** 每个请求默认换一个来源 IP，免得同文件里的用例互相吃 IP 锁；需要同 IP 时显式传 */
function call(path, { method = 'GET', body, cookie, https = false, ip, origin, headers = {} } = {}) {
  ipSeq += 1;
  return fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(https ? { 'x-forwarded-proto': 'https' } : {}),
      ...(origin ? { origin } : {}),
      'cf-connecting-ip': ip || `10.1.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const jsonOf = async (r) => ({ status: r.status, body: await r.json().catch(() => null), cookies: r.headers.getSetCookie() });
/** Set-Cookie 列表 → 请求用的 Cookie 头（只取有值的） */
const cookieHeader = (setCookies) => setCookies.map((c) => c.split(';')[0]).filter((kv) => !kv.endsWith('=')).join('; ');
const lastCodeFor = (email) => {
  const m = [...sentMail].reverse().find((x) => x.to === email);
  return m?.text.match(/(\d{6})/)?.[1];
};
const newEmail = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
const GOOD_PW = 'violet-tram-47';

async function register(email = newEmail(), { https = false } = {}) {
  const s = await jsonOf(await call('/api/auth/register/start', { method: 'POST', body: { email, password: GOOD_PW } }));
  expect(s.status).toBe(200);
  const v = await jsonOf(await call('/api/auth/register/verify', { method: 'POST', body: { email, code: lastCodeFor(email) }, https }));
  expect(v.status).toBe(201);
  return { email, user: v.body.user, cookie: cookieHeader(v.cookies), setCookies: v.cookies };
}

describe('identify', () => {
  it('用户名一律进密码框；没注册的邮箱进注册；注册过的邮箱按有无密码分流', async () => {
    expect((await jsonOf(await call('/api/auth/identify', { method: 'POST', body: { identifier: 'someone' } }))).body).toMatchObject({ kind: 'username', next: 'password' });
    const email = newEmail();
    expect((await jsonOf(await call('/api/auth/identify', { method: 'POST', body: { identifier: email } }))).body).toMatchObject({ exists: false, next: 'register' });
    await register(email);
    expect((await jsonOf(await call('/api/auth/identify', { method: 'POST', body: { identifier: email.toUpperCase() } }))).body).toMatchObject({ exists: true, next: 'password' });
  });
});

describe('邮箱注册', () => {
  it('错码不建号；对码建号、邮箱记为已验证、用户名从前缀派生、带会话 cookie', async () => {
    const email = newEmail();
    await call('/api/auth/register/start', { method: 'POST', body: { email, password: GOOD_PW } });
    const code = lastCodeFor(email);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await call('/api/auth/register/verify', { method: 'POST', body: { email, code: wrong } })).status).toBe(400);
    expect(getUserByEmail(email)).toBeNull();
    const v = await jsonOf(await call('/api/auth/register/verify', { method: 'POST', body: { email, code } }));
    expect(v.status).toBe(201);
    expect(v.body.user.email).toBe(email);
    expect(v.body.user.username).toMatch(/^u/);
    expect(getUserByEmail(email).emailVerifiedAt).toBeTruthy();
    expect(v.cookies[0]).toMatch(/^nd_auth=s1\./);   // http 请求：普通名
    const ping = await jsonOf(await call('/api/ping', { cookie: cookieHeader(v.cookies) }));
    expect(ping.body).toMatchObject({ kind: 'session' });
  });
  it('常见弱密码、已注册的邮箱在发码之前就拒', async () => {
    const email = newEmail();
    expect((await jsonOf(await call('/api/auth/register/start', { method: 'POST', body: { email, password: 'password123' } }))).body.code).toBe('PASSWORD_TOO_COMMON');
    const { email: taken } = await register();
    expect((await call('/api/auth/register/start', { method: 'POST', body: { email: taken, password: GOOD_PW } })).status).toBe(409);
  });
  it('https 下 cookie 是 __Host- 名、带 Secure', async () => {
    const { setCookies } = await register(newEmail(), { https: true });
    expect(setCookies[0]).toMatch(/^__Host-nd_auth=s1\..*; Secure/);
  });
});

describe('登录', () => {
  it('邮箱、用户名（不分大小写）都能登；错密码回同一句话', async () => {
    const { email, user } = await register();
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: GOOD_PW } })).status).toBe(200);
    expect((await call('/api/auth/login', { method: 'POST', body: { username: user.username.toUpperCase(), password: GOOD_PW } })).status).toBe(200);
    const bad = await jsonOf(await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: 'nope-nope-1' } }));
    const ghost = await jsonOf(await call('/api/auth/login', { method: 'POST', body: { identifier: 'no-such-user-xyz', password: 'nope-nope-1' } }));
    expect(bad.status).toBe(401);
    expect(ghost.body.error).toBe(bad.body.error);
  });
  it('攻击：同一登录名 15 分钟内错 10 次后，正确密码也回 401（换 IP 也没用）', async () => {
    const { email } = await register();
    for (let i = 0; i < 10; i += 1) await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: `wrong-${i}-xx` } });
    const r = await jsonOf(await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: GOOD_PW } }));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('账号或密码错误');
    // 验证码登录不受影响
    await call('/api/auth/login/code/start', { method: 'POST', body: { email } });
    expect((await call('/api/auth/login/code/verify', { method: 'POST', body: { email, code: lastCodeFor(email) } })).status).toBe(200);
  });
  it('攻击：*.share 子域发来的登录请求 403', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { identifier: 'x', password: 'y' }, origin: 'https://evil.share.xiaobuyu.trade' });
    expect(r.status).toBe(403);
  });
  it('同一浏览器再次登录：请求自带的旧会话被吊销，不在列表里留幽灵行', async () => {
    const { email, cookie } = await register();
    const again = await jsonOf(await call('/api/auth/login', { method: 'POST', cookie, body: { identifier: email, password: GOOD_PW } }));
    expect(again.status).toBe(200);
    expect((await call('/api/ping', { cookie })).status).toBe(401);
    const list = await jsonOf(await call('/api/me/account/sessions', { cookie: cookieHeader(again.cookies) }));
    expect(list.body.sessions.length).toBe(1);
  });
  it('攻击：偷到会话在「重新验证」里爆破密码，10 次后正确密码也不放行', async () => {
    const { cookie } = await register();
    for (let i = 0; i < 10; i += 1) await call('/api/me/account/reauth', { method: 'POST', cookie, body: { password: `guess-${i}-xx` } });
    expect((await call('/api/me/account/reauth', { method: 'POST', cookie, body: { password: GOOD_PW } })).status).toBe(401);
  });
  it('攻击：用户名和邮箱轮着试，按账号 id 的计数照样暂停', async () => {
    const { email, user } = await register();
    for (let i = 0; i < 10; i += 1) {
      await call('/api/auth/login', { method: 'POST', body: { identifier: i % 2 ? email : user.username, password: `wrong-${i}-yy` } });
    }
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: GOOD_PW } })).status).toBe(401);
  });
  it('退出登录吊销会话：同一个 cookie 再用 401', async () => {
    const { cookie } = await register();
    expect((await call('/api/ping', { cookie })).status).toBe(200);
    expect((await call('/api/auth/logout', { method: 'POST', cookie })).status).toBe(200);
    expect((await call('/api/ping', { cookie })).status).toBe(401);
  });
});

describe('cookie 与旧 token', () => {
  it('攻击：https 请求只带普通名的会话 cookie（子域能写的那种）不认', async () => {
    const { setCookies } = await register(newEmail(), { https: true });
    const value = setCookies[0].split(';')[0].split('=').slice(1).join('=');
    expect((await call('/api/ping', { cookie: `__Host-nd_auth=${value}`, https: true })).status).toBe(200);
    expect((await call('/api/ping', { cookie: `nd_auth=${value}`, https: true })).status).toBe(401);
  });
  it('攻击：没配过渡期（NODESIGN_LEGACY_TOKEN_UNTIL）时，https 下不认旧名里的 v2 token', async () => {
    const { user } = await register();
    delete process.env.NODESIGN_LEGACY_TOKEN_UNTIL;
    expect((await call('/api/ping', { cookie: `nd_auth=${mintToken(user.id)}`, https: true })).status).toBe(401);
    process.env.NODESIGN_LEGACY_TOKEN_UNTIL = new Date(Date.now() - 1000).toISOString();
    expect((await call('/api/ping', { cookie: `nd_auth=${mintToken(user.id)}`, https: true })).status).toBe(401);
    // http（本机入口）不受期限约束
    expect((await call('/api/ping', { cookie: `nd_auth=${mintToken(user.id)}` })).status).toBe(200);
    delete process.env.NODESIGN_LEGACY_TOKEN_UNTIL;
  });
  it('旧 v2 token：过渡期内 https 下从旧名读到、换发成 __Host- 会话，连父域那份一起清；换发出的会话不算刚验证过身份', async () => {
    process.env.NODESIGN_LEGACY_TOKEN_UNTIL = new Date(Date.now() + 86400_000).toISOString();
    process.env.NODESIGN_COOKIE_PARENT_DOMAIN = 'xiaobuyu.trade';
    const { user } = await register();
    const legacy = `nd_auth=${mintToken(user.id)}`;
    const r = await jsonOf(await call('/api/ping', { cookie: legacy, https: true }));
    expect(r.body).toMatchObject({ kind: 'legacy', userId: user.id });
    expect(r.cookies[0]).toMatch(/^__Host-nd_auth=s1\./);
    expect(r.cookies[1]).toMatch(/^nd_auth=; /);
    expect(r.cookies.some((c) => /^nd_auth=; Domain=xiaobuyu\.trade;/.test(c))).toBe(true);
    const upgraded = cookieHeader(r.cookies);
    expect((await jsonOf(await call('/api/ping', { cookie: upgraded, https: true }))).body.kind).toBe('session');
    const acct = await jsonOf(await call('/api/me/account', { cookie: upgraded, https: true }));
    expect(acct.body.recentAuth).toBe(false);
    expect((await call('/api/me/account/email/start', { method: 'POST', cookie: upgraded, https: true, body: { email: newEmail() } })).status).toBe(403);
    delete process.env.NODESIGN_LEGACY_TOKEN_UNTIL;
    delete process.env.NODESIGN_COOKIE_PARENT_DOMAIN;
  });
  it('内部凭证能过 authGuard', async () => {
    const { user } = await register();
    const c = mintInternalCookie(user.id);
    expect((await jsonOf(await call('/api/ping', { cookie: `${c.name}=${c.value}` }))).body).toMatchObject({ kind: 'internal', userId: user.id });
  });
});

describe('找回密码', () => {
  it('全链路：重设令牌一次性；弱密码不收；成功后旧会话、旧 v2、桌面设备、内部凭证全部失效；发通知', async () => {
    const { email, user, cookie } = await register();
    const legacyCookie = `nd_auth=${mintToken(user.id, Date.now() - 1000)}`;
    const internal = mintInternalCookie(user.id);
    const { token: deviceToken } = mintDevice({ userId: user.id, label: 'test' });
    expect(verifyDeviceToken(deviceToken)).not.toBeNull();

    await call('/api/auth/password/forgot/start', { method: 'POST', body: { email } });
    const fv = await jsonOf(await call('/api/auth/password/forgot/verify', { method: 'POST', body: { email, code: lastCodeFor(email) } }));
    expect(fv.status).toBe(200);
    const { resetToken } = fv.body;
    expect((await jsonOf(await call('/api/auth/password/reset', { method: 'POST', body: { resetToken, password: '12345678' } }))).body.code).toBe('PASSWORD_TOO_COMMON');
    const done = await jsonOf(await call('/api/auth/password/reset', { method: 'POST', body: { resetToken, password: 'new-violet-58' } }));
    expect(done.status).toBe(200);
    expect((await call('/api/auth/password/reset', { method: 'POST', body: { resetToken, password: 'another-violet-9' } })).status).toBe(400);

    expect((await call('/api/ping', { cookie })).status).toBe(401);
    expect((await call('/api/ping', { cookie: legacyCookie })).status).toBe(401);
    expect((await call('/api/ping', { cookie: `${internal.name}=${internal.value}` })).status).toBe(401);
    expect(verifyDeviceToken(deviceToken)).toBeNull();
    expect((await call('/api/ping', { cookie: cookieHeader(done.cookies) })).status).toBe(200);
    expect(sentMail.some((m) => m.to === email && /重设/.test(m.subject))).toBe(true);
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: 'new-violet-58' } })).status).toBe(200);
  });
  it('攻击：没拿到重设令牌直接设密 400', async () => {
    expect((await call('/api/auth/password/reset', { method: 'POST', body: { resetToken: 'x'.repeat(43), password: 'new-violet-58' } })).status).toBe(400);
  });
});

describe('账号与安全', () => {
  it('改密码要当前密码；改完其他会话下线、当前会话保留', async () => {
    const { email, cookie } = await register();
    const other = await jsonOf(await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: GOOD_PW } }));
    const otherCookie = cookieHeader(other.cookies);
    expect((await call('/api/me/account/password', { method: 'PUT', cookie, body: { currentPassword: 'wrong-one-1', newPassword: 'fresh-violet-77' } })).status).toBe(401);
    const ok = await jsonOf(await call('/api/me/account/password', { method: 'PUT', cookie, body: { currentPassword: GOOD_PW, newPassword: 'fresh-violet-77' } }));
    expect(ok.status).toBe(200);
    expect(ok.body.sessionsRevoked).toBe(1);
    expect((await call('/api/ping', { cookie })).status).toBe(200);
    expect((await call('/api/ping', { cookie: otherCookie })).status).toBe(401);
  });
  it('换邮箱：刚登录可以；5 分钟前的会话要先重新验证；新邮箱收码、旧邮箱收通知', async () => {
    const { email, cookie, user } = await register();
    const sid = db.prepare('SELECT id FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id).id;
    db.prepare('UPDATE auth_sessions SET authenticated_at = ? WHERE id = ?').run(Date.now() - 6 * 60_000, sid);
    const next = newEmail();
    expect((await jsonOf(await call('/api/me/account/email/start', { method: 'POST', cookie, body: { email: next } }))).body.code).toBe('REAUTH_REQUIRED');
    expect((await call('/api/me/account/reauth', { method: 'POST', cookie, body: { password: 'wrong-one-1' } })).status).toBe(401);
    expect((await call('/api/me/account/reauth', { method: 'POST', cookie, body: { password: GOOD_PW } })).status).toBe(200);
    expect((await call('/api/me/account/email/start', { method: 'POST', cookie, body: { email: next } })).status).toBe(200);
    const v = await jsonOf(await call('/api/me/account/email/verify', { method: 'POST', cookie, body: { email: next, code: lastCodeFor(next) } }));
    expect(v.status).toBe(200);
    expect(v.body.user.email).toBe(next);
    expect(sentMail.some((m) => m.to === email && /更换|changed/.test(m.subject))).toBe(true);
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: next, password: GOOD_PW } })).status).toBe(200);
  });
  it('攻击：别人账号签的换邮箱验证码，拿到自己会话里核验不通过', async () => {
    const a = await register();
    const b = await register();
    const target = newEmail();
    await call('/api/me/account/email/start', { method: 'POST', cookie: a.cookie, body: { email: target } });
    const code = lastCodeFor(target);
    expect((await call('/api/me/account/email/verify', { method: 'POST', cookie: b.cookie, body: { email: target, code } })).status).toBe(400);
  });
  it('老用户（无邮箱）绑定邮箱：登录后刚验证过身份即可绑；绑完能用邮箱登录', async () => {
    const legacyUser = createUser({ username: `old${Date.now().toString(36)}`, password: GOOD_PW });
    const login = await jsonOf(await call('/api/auth/login', { method: 'POST', body: { username: legacyUser.username, password: GOOD_PW } }));
    const cookie = cookieHeader(login.cookies);
    expect((await jsonOf(await call('/api/me/account', { cookie }))).body.user.email).toBeNull();
    const mail = newEmail();
    expect((await call('/api/me/account/email/start', { method: 'POST', cookie, body: { email: mail } })).status).toBe(200);
    expect((await call('/api/me/account/email/verify', { method: 'POST', cookie, body: { email: mail, code: lastCodeFor(mail) } })).status).toBe(200);
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: mail, password: GOOD_PW } })).status).toBe(200);
  });
  it('列会话、删一条、退出其他所有设备（含桌面令牌）', async () => {
    const { email, cookie, user } = await register();
    await call('/api/auth/login', { method: 'POST', body: { identifier: email, password: GOOD_PW } });
    const list = await jsonOf(await call('/api/me/account/sessions', { cookie }));
    expect(list.body.sessions.length).toBe(2);
    expect(list.body.sessions.filter((s) => s.current).length).toBe(1);
    const { token } = mintDevice({ userId: user.id, label: 'pc' });
    const r = await jsonOf(await call('/api/me/account/sessions/revoke-others', { method: 'POST', cookie }));
    expect(r.body).toMatchObject({ sessionsRevoked: 1, devicesRevoked: 1 });
    expect(verifyDeviceToken(token)).toBeNull();
    const again = await jsonOf(await call('/api/me/account/sessions', { cookie }));
    expect(again.body.sessions.length).toBe(1);
    // 删别人的会话当不存在
    const stranger = await register();
    const strangerSid = (await jsonOf(await call('/api/me/account/sessions', { cookie: stranger.cookie }))).body.sessions[0].id;
    expect((await call(`/api/me/account/sessions/${strangerSid}`, { method: 'DELETE', cookie })).status).toBe(404);
  });
  it('改用户名：撞名 409；改完能用新名登录', async () => {
    const a = await register();
    const b = await register();
    expect((await call('/api/me/account/username', { method: 'PUT', cookie: a.cookie, body: { username: b.user.username.toUpperCase() } })).status).toBe(409);
    const name = `新名字${Date.now().toString(36).slice(-4)}`;
    expect((await call('/api/me/account/username', { method: 'PUT', cookie: a.cookie, body: { username: name } })).status).toBe(200);
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: name, password: GOOD_PW } })).status).toBe(200);
  });
  it('停用账号后会话立即失效（requestAuth 返回 null）', async () => {
    const { cookie, user } = await register();
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    const { invalidateUserCache } = await import('../../auth/users-store.js');
    invalidateUserCache(user.id);
    expect(requestAuth({ headers: { cookie } })).toBeNull();
  });
});
