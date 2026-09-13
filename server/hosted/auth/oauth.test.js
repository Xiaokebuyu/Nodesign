/**
 * auth-v2 第二批：Google / GitHub 登录与关联的端到端。
 * 服务商是本文件里起的假服务：授权码登记在内存，令牌端点真的校验 PKCE（S256）、client_secret 与 redirect_uri，
 * Google 的 ID token 带 nonce（签名是假的：oauth4webapi 对令牌端点直取的 ID token 不验签，与生产一致）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

process.env.NODESIGN_MAIL_PROVIDER = 'memory';
process.env.NODESIGN_OPEN_REGISTRATION = '1';
process.env.NODESIGN_AUTH_SECRET = 'test-secret-oauth';
process.env.NODESIGN_AUTH_PASSWORD = 'bootstrap-not-used';
process.env.NODESIGN_GOOGLE_CLIENT_ID = 'g-client';
process.env.NODESIGN_GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.NODESIGN_GITHUB_CLIENT_ID = 'gh-client';
process.env.NODESIGN_GITHUB_CLIENT_SECRET = 'gh-secret';
delete process.env.NODESIGN_SESSION_COOKIE;

const db = (await import('../../engine/runs/store.js')).default;
const { installSessionBackend, _resetSessionBackend } = await import('../../auth/session.js');
const { authRouter, authGuard } = await import('../../auth/middleware.js');
const { hostedAuthRouter, _resetAuthThrottles } = await import('../auth-routes.js');
const { resolveRequest, logoutRequest } = await import('./sessions-store.js');
const { default: accountRouter } = await import('./account-routes.js');
const { sentMail } = await import('./mailer.js');
const { _setProviderOverrides } = await import('./oauth-providers.js');
const { safeReturnTo, _resetOAuthState } = await import('./oauth-routes.js');
const { findIdentity } = await import('./identities-store.js');
const { getUserByEmail, invalidateUserCache } = await import('../../auth/users-store.js');

// ── 假服务商 ──
const codes = new Map();   // code → { provider, challenge, redirectUri, clientId, profile, nonce }
const tokens = new Map();  // access_token → profile（GitHub）
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname.endsWith('/token')) {
      const f = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const hit = codes.get(f.get('code'));
      codes.delete(f.get('code'));   // 授权码一次性
      const provider = url.pathname.startsWith('/google') ? 'google' : 'github';
      const secret = provider === 'google' ? 'g-secret' : 'gh-secret';
      const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (!hit || hit.provider !== provider || f.get('client_secret') !== secret || hit.challenge !== challenge || hit.redirectUri !== f.get('redirect_uri')) {
        return send(400, { error: 'invalid_grant' });
      }
      const access = crypto.randomBytes(16).toString('hex');
      if (provider === 'github') {
        tokens.set(access, hit.profile);
        return send(200, { access_token: access, token_type: 'bearer', scope: 'read:user,user:email' });
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: hit.profile.issOverride ?? 'https://accounts.google.com', aud: hit.clientId, iat: now, exp: now + 300, nonce: hit.profile.nonceOverride ?? hit.nonce, ...hit.profile.claims };
      return send(200, { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}.c2ln` });
    }
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const profile = tokens.get(auth);
    if (url.pathname === '/github/api/user') return profile ? send(200, profile.user) : send(401, {});
    if (url.pathname === '/github/api/user/emails') return profile ? send(200, profile.emails) : send(401, {});
    send(404, {});
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

let server; let base;
beforeAll(async () => {
  installSessionBackend({ resolve: resolveRequest, logout: logoutRequest });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', hostedAuthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api', authGuard);
  app.use('/api/me/account', accountRouter);
  app.get('/api/ping', (req, res) => res.json({ userId: req.user.id }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.NODESIGN_PUBLIC_ORIGIN = base;
  _setProviderOverrides({
    insecure: true,
    google: { as: { authorization_endpoint: `${fakeBase}/google/authorize`, token_endpoint: `${fakeBase}/google/token` } },
    github: { as: { authorization_endpoint: `${fakeBase}/github/authorize`, token_endpoint: `${fakeBase}/github/token` }, api: `${fakeBase}/github/api` },
  });
});
afterAll(async () => {
  _setProviderOverrides(null);
  _resetSessionBackend();
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
});
beforeEach(() => { _resetAuthThrottles(); _resetOAuthState(); process.env.NODESIGN_OPEN_REGISTRATION = '1'; });

let ipSeq = 0;
const call = (path, { method = 'GET', body, cookie } = {}) => {
  ipSeq += 1;
  return fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), 'cf-connecting-ip': `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  });
};
const cookiesOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((kv) => !kv.endsWith('='));
const joinCookies = (...lists) => lists.flat().filter(Boolean).join('; ');
const newEmail = (domain = 'example.com') => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${domain}`;
const lastCodeFor = (email) => [...sentMail].reverse().find((m) => m.to === email)?.text.match(/(\d{6})/)?.[1];
const GOOD_PW = 'violet-tram-47';

/**
 * 走一遍：start → （假装用户在服务商那边同意）→ callback。
 * @returns {{ location: string, cookies: string[], start: Response }}
 */
async function oauthFlow(provider, profile, { cookie = '', intent = 'login', ret = null, tamper = null } = {}) {
  const q = new URLSearchParams({ ...(intent === 'link' ? { intent } : {}), ...(ret ? { return: ret } : {}) });
  const start = await call(`/api/auth/oauth/${provider}/start?${q}`, { cookie });
  const loc = start.headers.get('location');
  if (!loc.startsWith(fakeBase)) return { location: loc, cookies: [], start };
  const auth = new URL(loc);
  const flowCookie = cookiesOf(start);
  const code = crypto.randomBytes(8).toString('hex');
  codes.set(code, {
    provider, challenge: auth.searchParams.get('code_challenge'), redirectUri: auth.searchParams.get('redirect_uri'),
    clientId: auth.searchParams.get('client_id'), nonce: auth.searchParams.get('nonce'), profile,
  });
  if (provider === 'github') tokens.set('unused', profile);
  let state = auth.searchParams.get('state');
  let flow = flowCookie;
  // 首字符换成一个一定不同的字符（原来写死 'x'：state 本身以 x 开头时等于没改，1/64 概率假红）
  if (tamper === 'state') state = (state[0] === 'x' ? 'y' : 'x') + state.slice(1);
  if (tamper === 'no_cookie') flow = [];
  if (tamper === 'bad_sig') flow = flowCookie.map((c) => c.replace(/\.[^.]+$/, '.AAAA'));
  const cb = await call(`/api/auth/oauth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`, { cookie: joinCookies(cookie, flow) });
  return { location: cb.headers.get('location'), cookies: cookiesOf(cb), start, callbackUrl: `/api/auth/oauth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`, flow };
}

const google = ({ sub = crypto.randomBytes(6).toString('hex'), email, verified = true, hd } = {}) => ({ claims: { sub, email, email_verified: verified, ...(hd ? { hd } : {}), name: 'Test User' } });
const github = ({ id = Math.floor(Math.random() * 1e9), login = `gh${Date.now().toString(36)}`, emails }) => ({ user: { id, login, name: null }, emails });

async function registerWithPassword(email) {
  await call('/api/auth/register/start', { method: 'POST', body: { email, password: GOOD_PW } });
  const v = await call('/api/auth/register/verify', { method: 'POST', body: { email, code: lastCodeFor(email) } });
  expect(v.status).toBe(201);
  return { cookie: joinCookies(cookiesOf(v)), user: (await v.json()).user };
}

describe('providers 与回跳地址', () => {
  it('配了 client id 的两家都列出来', async () => {
    expect(await (await call('/api/auth/oauth/providers')).json()).toEqual({ providers: ['google', 'github'] });
  });
  it('攻击：回跳地址只收站内相对路径', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', '/a\r\nSet-Cookie: x']) expect(safeReturnTo(bad)).toBe('/');
    expect(safeReturnTo('/projects/p1?x=1')).toBe('/projects/p1?x=1');
  });
});

describe('Google 登录', () => {
  it('新用户（gmail）：建号、邮箱记为已验证、关联身份、带会话回首页；第二次登录同一个号', async () => {
    const email = newEmail('gmail.com');
    const profile = google({ email });
    const first = await oauthFlow('google', profile);
    expect(first.location).toBe('/');
    const user = getUserByEmail(email);
    expect(user).toBeTruthy();
    expect(user.emailVerifiedAt).toBeTruthy();
    expect(user.hasPassword).toBe(false);
    expect(findIdentity('google', profile.claims.sub).user_id).toBe(user.id);
    expect((await call('/api/ping', { cookie: joinCookies(first.cookies) })).status).toBe(200);
    const second = await oauthFlow('google', profile);
    expect(second.location).toBe('/');
    expect((await (await call('/api/ping', { cookie: joinCookies(second.cookies) })).json()).userId).toBe(user.id);
  });
  it('没设密码的第三方号 + Gmail（可信）：自动关联并登录，发通知邮件', async () => {
    const email = newEmail('gmail.com');
    await oauthFlow('github', github({ emails: [{ email, primary: true, verified: true }] }));   // 先用 GitHub 建出一个没密码的号
    const user = getUserByEmail(email);
    expect(user.hasPassword).toBe(false);
    const r = await oauthFlow('google', google({ email }));
    expect(r.location).toBe('/');
    expect((await (await call('/api/ping', { cookie: joinCookies(r.cookies) })).json()).userId).toBe(user.id);
    expect(sentMail.some((m) => m.to === email && /关联/.test(m.subject))).toBe(true);
  });
  it('攻击：设了密码的号，即使 GitHub 邮箱可信也不自动关联（邮箱可能是被回收后转给新人的）', async () => {
    const email = newEmail();
    await registerWithPassword(email);
    const profile = github({ emails: [{ email, primary: true, verified: true }] });
    const r = await oauthFlow('github', profile);
    expect(r.location).toMatch(/^\/login#oauth_pending=/);
    expect(findIdentity('github', profile.user.id)).toBeNull();
  });
  it('攻击：已有邮箱账号 + 非 Gmail 且无 hd（不可信）：不自动关联，要邮箱验证码', async () => {
    const email = newEmail('corp.example');
    const { user } = await registerWithPassword(email);
    const profile = google({ email });
    const r = await oauthFlow('google', profile);
    expect(r.location).toMatch(/^\/login#oauth_pending=/);
    expect(r.cookies.some((c) => /^nd_auth=s1\./.test(c))).toBe(false);
    expect(findIdentity('google', profile.claims.sub)).toBeNull();
    const token = r.location.split('#oauth_pending=')[1];
    const info = await (await call('/api/auth/oauth/pending/lookup', { method: 'POST', body: { token } })).json();
    expect(info).toMatchObject({ provider: 'google', email: expect.stringMatching(/^o\*\*\*@corp\.example$/) });
    const code = lastCodeFor(email);
    expect((await call('/api/auth/oauth/pending/verify', { method: 'POST', body: { token, code: code === '000000' ? '111111' : '000000' } })).status).toBe(400);
    const ok = await call('/api/auth/oauth/pending/verify', { method: 'POST', body: { token, code } });
    expect(ok.status).toBe(200);
    expect(findIdentity('google', profile.claims.sub).user_id).toBe(user.id);
    expect((await call('/api/auth/oauth/pending/verify', { method: 'POST', body: { token, code } })).status).toBe(404);
  });
  it('带 hd 的 Workspace 邮箱算可信（对没密码的号自动关联）', async () => {
    const email = newEmail('corp2.example');
    await oauthFlow('github', github({ emails: [{ email, primary: true, verified: true }] }));
    const user = getUserByEmail(email);
    const r = await oauthFlow('google', google({ email, hd: 'corp2.example' }));
    expect(r.location).toBe('/');
    expect((await (await call('/api/ping', { cookie: joinCookies(r.cookies) })).json()).userId).toBe(user.id);
  });
  it('ID token 的 iss 是不带 https 的 accounts.google.com 也认', async () => {
    const email = newEmail('gmail.com');
    const r = await oauthFlow('google', { ...google({ email }), issOverride: 'accounts.google.com' });
    expect(r.location).toBe('/');
    expect(getUserByEmail(email)).toBeTruthy();
  });
  it('攻击：iss 是别的签发方 → 换令牌失败', async () => {
    const email = newEmail('gmail.com');
    const r = await oauthFlow('google', { ...google({ email }), issOverride: 'https://evil.example' });
    expect(r.location).toMatch(/oauth_error=token_exchange_failed/);
    expect(getUserByEmail(email)).toBeNull();
  });
  it('攻击：回调地址变了（临时 cookie 是在另一个站点地址下签的）→ state_mismatch', async () => {
    const saved = process.env.NODESIGN_PUBLIC_ORIGIN;
    const start = await call('/api/auth/oauth/google/start');
    const auth = new URL(start.headers.get('location'));
    process.env.NODESIGN_PUBLIC_ORIGIN = 'https://nodesign.xiaobuyu.trade:8443';
    try {
      const cb = await call(`/api/auth/oauth/google/callback?code=x&state=${auth.searchParams.get('state')}`, { cookie: joinCookies(cookiesOf(start)) });
      expect(cb.headers.get('location')).toMatch(/oauth_error=state_mismatch/);
    } finally {
      process.env.NODESIGN_PUBLIC_ORIGIN = saved;
    }
  });
  it('用户在服务商那边点了拒绝 → access_denied；错误码不在白名单的一律 provider_error', async () => {
    const start = await call('/api/auth/oauth/google/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const denied = await call(`/api/auth/oauth/google/callback?error=access_denied&state=${state}`, { cookie: joinCookies(cookiesOf(start)) });
    expect(denied.headers.get('location')).toBe('/login?oauth_error=access_denied');
    const start2 = await call('/api/auth/oauth/google/start');
    const state2 = new URL(start2.headers.get('location')).searchParams.get('state');
    const weird = await call(`/api/auth/oauth/google/callback?error=server_on_fire&state=${state2}`, { cookie: joinCookies(cookiesOf(start2)) });
    expect(weird.headers.get('location')).toBe('/login?oauth_error=provider_error');
  });
  it('从别的页面发起（桌面版登录确认页）：成功回原页；失败 / 要输验证码也回原页，原页参数不丢（09-13 第四批）', async () => {
    const ret = '/desktop-auth?port=45678&state=abcdefghijklmnop&challenge=' + 'c'.repeat(43);
    const ok = await oauthFlow('google', google({ email: newEmail('gmail.com') }), { ret });
    expect(ok.location).toBe(ret);
    const bad = await oauthFlow('google', google({ email: newEmail('gmail.com') }), { ret, tamper: 'state' });
    expect(bad.location).toBe(`${ret}&oauth_error=state_mismatch`);
    const off = await call(`/api/auth/oauth/nope/start?return=${encodeURIComponent(ret)}`);
    expect(off.headers.get('location')).toBe(`${ret}&oauth_error=provider_unavailable`);
    // 首页发起的照旧回 /login
    const home = await oauthFlow('google', google({ email: newEmail('gmail.com') }), { tamper: 'state' });
    expect(home.location).toBe('/login?oauth_error=state_mismatch');
  });
  it('攻击：没 state cookie、state 被改、cookie 签名被改、回调重放，一律 state_mismatch，不建号不登录', async () => {
    for (const tamper of ['no_cookie', 'state', 'bad_sig']) {
      const email = newEmail('gmail.com');
      const r = await oauthFlow('google', google({ email }), { tamper });
      expect(r.location, tamper).toMatch(/oauth_error=state_mismatch/);
      expect(getUserByEmail(email), tamper).toBeNull();
    }
    const email = newEmail('gmail.com');
    const ok = await oauthFlow('google', google({ email }));
    expect(ok.location).toBe('/');
    const replay = await call(ok.callbackUrl, { cookie: joinCookies(ok.flow) });   // 同一枚临时 cookie 再用一次：授权码已作废
    expect(replay.headers.get('location')).toMatch(/oauth_error=/);
  });
  it('攻击：ID token 的 nonce 对不上 → 换令牌失败', async () => {
    const email = newEmail('gmail.com');
    const profile = { ...google({ email }), nonceOverride: 'attacker-nonce' };
    const r = await oauthFlow('google', profile);
    expect(r.location).toMatch(/oauth_error=token_exchange_failed/);
    expect(getUserByEmail(email)).toBeNull();
  });
  it('邮箱未验证 → no_verified_email；开放注册关着 → registration_closed', async () => {
    expect((await oauthFlow('google', google({ email: newEmail('gmail.com'), verified: false }))).location).toMatch(/no_verified_email/);
    process.env.NODESIGN_OPEN_REGISTRATION = '';
    expect((await oauthFlow('google', google({ email: newEmail('gmail.com') }))).location).toMatch(/registration_closed/);
  });
  it('停用的账号不能靠第三方登录进来', async () => {
    const email = newEmail('gmail.com');
    const profile = google({ email });
    await oauthFlow('google', profile);
    const user = getUserByEmail(email);
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
    invalidateUserCache(user.id);
    expect((await oauthFlow('google', profile)).location).toMatch(/login_failed/);
  });
});

describe('GitHub 登录', () => {
  it('取 primary 且 verified 的邮箱建号，用户名取 login；只有未验证邮箱时拒', async () => {
    const email = newEmail();
    const login = `octo${Date.now().toString(36)}`;
    const r = await oauthFlow('github', github({ login, emails: [{ email: 'noise@example.com', primary: false, verified: true }, { email, primary: true, verified: true }] }));
    expect(r.location).toBe('/');
    expect(getUserByEmail(email).username).toBe(login);
    const bad = await oauthFlow('github', github({ emails: [{ email: newEmail(), primary: true, verified: false }] }));
    expect(bad.location).toMatch(/no_verified_email/);
  });
  it('攻击：GitHub /user 缺 id → profile_fetch_failed，不会把缺 id 的人并到同一个号', async () => {
    const r = await oauthFlow('github', { user: { login: 'no-id' }, emails: [{ email: newEmail(), primary: true, verified: true }] });
    expect(r.location).toMatch(/oauth_error=profile_fetch_failed/);
  });
  it('服务商给的邮箱不合规范（非 ASCII）→ no_verified_email，不建无邮箱无密码的号', async () => {
    const r = await oauthFlow('github', github({ emails: [{ email: '用户@例子.中国', primary: true, verified: true }] }));
    expect(r.location).toMatch(/oauth_error=no_verified_email/);
  });
  it('回跳地址：站内路径原样回去，外站地址落回首页', async () => {
    const ok = await oauthFlow('github', github({ emails: [{ email: newEmail(), primary: true, verified: true }] }), { ret: '/projects/abc' });
    expect(ok.location).toBe('/projects/abc');
    const evil = await oauthFlow('github', github({ emails: [{ email: newEmail(), primary: true, verified: true }] }), { ret: '//evil.com/x' });
    expect(evil.location).toBe('/');
  });
});

describe('账号页关联与解除', () => {
  it('关联要刚验证过身份；关联成功回设置页；解除要留至少一种登录方式', async () => {
    const email = newEmail();
    const { cookie, user } = await registerWithPassword(email);
    const sid = db.prepare('SELECT id FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id).id;
    db.prepare('UPDATE auth_sessions SET authenticated_at = ? WHERE id = ?').run(Date.now() - 10 * 60_000, sid);
    const stale = await oauthFlow('google', google({ email: newEmail('gmail.com') }), { cookie, intent: 'link' });
    expect(stale.location).toMatch(/^\/settings\?oauth_error=reauth_required/);
    await call('/api/me/account/reauth', { method: 'POST', cookie, body: { password: GOOD_PW } });
    const profile = google({ email: newEmail('gmail.com') });
    const linked = await oauthFlow('google', profile, { cookie, intent: 'link' });
    expect(linked.location).toBe('/settings?linked=google');
    expect(findIdentity('google', profile.claims.sub).user_id).toBe(user.id);
    const acct = await (await call('/api/me/account', { cookie })).json();
    expect(acct.identities.map((i) => i.provider)).toEqual(['google']);
    expect((await call('/api/me/account/identities/google', { method: 'DELETE', cookie })).status).toBe(200);   // 有密码，可以解
    expect(findIdentity('google', profile.claims.sub)).toBeNull();
  });
  it('攻击：别人已关联的 Google 不能再关联到自己号上', async () => {
    const profile = google({ email: newEmail('gmail.com') });
    await oauthFlow('google', profile);   // 被第一个人拿去建了号
    const { cookie } = await registerWithPassword(newEmail());
    const r = await oauthFlow('google', profile, { cookie, intent: 'link' });
    expect(r.location).toMatch(/oauth_error=identity_taken/);
  });
  it('攻击：发起关联后浏览器换了登录会话，回调拒绝（关联只落在发起它的会话上）', async () => {
    const a = await registerWithPassword(newEmail());
    const b = await registerWithPassword(newEmail());
    const q = new URLSearchParams({ intent: 'link' });
    const start = await call(`/api/auth/oauth/google/start?${q}`, { cookie: a.cookie });
    const auth = new URL(start.headers.get('location'));
    const code = crypto.randomBytes(8).toString('hex');
    const profile = google({ email: newEmail('gmail.com') });
    codes.set(code, { provider: 'google', challenge: auth.searchParams.get('code_challenge'), redirectUri: auth.searchParams.get('redirect_uri'), clientId: 'g-client', nonce: auth.searchParams.get('nonce'), profile });
    const cb = await call(`/api/auth/oauth/google/callback?code=${code}&state=${auth.searchParams.get('state')}`, { cookie: joinCookies(b.cookie, cookiesOf(start)) });
    expect(cb.headers.get('location')).toMatch(/oauth_error=session_changed/);
    expect(findIdentity('google', profile.claims.sub)).toBeNull();
  });
  it('只用第三方登录、没密码的号：唯一的关联不能解除', async () => {
    const email = newEmail('gmail.com');
    const r = await oauthFlow('google', google({ email }));
    const cookie = joinCookies(r.cookies);
    const del = await call('/api/me/account/identities/google', { method: 'DELETE', cookie });
    expect(del.status).toBe(400);
    expect((await del.json()).code).toBe('LAST_LOGIN_METHOD');
  });
});
