/**
 * server/hosted/auth/oauth-routes.js — Google / GitHub 登录与关联（挂在 /api/auth，authGuard 之前）
 *
 *   GET  /oauth/providers                      → { providers: ['google', 'github'] }（只列配好了的）
 *   GET  /methods                              → { providers, emailAuth, openRegistration }（登录页 / 账号页用）
 *   GET  /oauth/:provider/start?intent=&return= → 302 到服务商。intent = login（默认）| link（账号页关联，要刚验证过身份）
 *   GET  /oauth/:provider/callback             → 服务商跳回来。成功 302 到 return；失败 302 到 /login?oauth_error=<code>（码见 ERROR_CODES）；
 *                                                要邮箱验证码确认的 302 到 /login#oauth_pending=<token>
 *                                                （关联流程失败回 /settings?oauth_error=<code>）
 *   POST /oauth/pending/lookup { token }       → 待确认关联的概况（邮箱打码 + 服务商），登录页据此显示验证码框
 *   POST /oauth/pending/verify { token, code } → 输入发到该邮箱的验证码，确认关联并登录
 *   （令牌只走 body：它从 # 片段来，放进请求路径就又进访问日志了，fable 09-13）
 *
 * ## 临时 cookie
 *
 * state、PKCE verifier、nonce、意图、发起时的会话 id、回跳地址放在 10 分钟的 `__Host-<基名>_oauth` cookie 里，
 * 内容用服务端密钥做 HMAC。`__Host-` 前缀让 *.share 子域的发布页没法投一份自己的进来；绑定 sessionId 让「关联」
 * 只能关联到发起它的那个登录会话上（fable 09-13 方案评审第 1 条）。回调一进来就清掉这枚 cookie。
 *
 * ## 账号匹配（设计方案 §5.6，按顺序）
 *
 *   1. (provider, subject) 已关联 → 登录那个账号（关联流程下：是自己的就算成功，是别人的拒）
 *   2. intent=link → 关联到发起时的会话账号
 *   3. 服务商给的邮箱与已有账号相同：邮箱可信且那个号没设密码 → 自动关联并登录、发通知；否则往该邮箱发验证码，确认后关联
 *   4. 没有匹配 → 建新号（开放注册 + 每 IP 每日注册名额），邮箱记为已验证
 *   5. 服务商没给已验证的邮箱 → 拒（没有邮箱的号找不回密码，也没法跟已有账号对上）
 */

import crypto from 'node:crypto';
import { getUserById, getUserByEmail } from '../../auth/users-store.js';
import { publicUser } from '../../auth/middleware.js';
import { authSecret, cookieBaseName, cookieValue, isSecureRequest, requestAuth } from '../../auth/session.js';
import { makeRateWindow } from '../../lib/rate-window.js';
import { msg } from '../../shared/messages.js';
import { clientIp } from './client-ip.js';
import { registerViaOAuth } from '../users-write.js';
import { PROVIDERS, findIdentity, linkIdentity } from './identities-store.js';
import { enabledProviders, providerEnabled, beginAuthorization, completeAuthorization, redirectUri } from './oauth-providers.js';
import { startSession, getSession } from './sessions-store.js';
import { verifyCode } from './email-codes.js';
import { sendCode, codeErrorResponse, noticeMailSafe } from './code-mail.js';
import { recordAuthEvent } from './audit.js';

const FLOW_TTL_MS = 10 * 60 * 1000;
const RECENT_AUTH_MS = 5 * 60 * 1000;
const startWindow = makeRateWindow({ limit: 20, windowMs: 60_000 });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', authSecret()).update(`nd-oauth-flow:${s}`).digest('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function flowCookieName(req) {
  return `${isSecureRequest(req) ? '__Host-' : ''}${cookieBaseName()}_oauth`;
}

function setFlowCookie(res, req, payload) {
  const body = b64u(JSON.stringify(payload));
  const attrs = [`${flowCookieName(req)}=${body}.${hmac(body)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${FLOW_TTL_MS / 1000}`];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearFlowCookie(req) {
  return `${flowCookieName(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureRequest(req) ? '; Secure' : ''}`;
}

/** @returns {object|null} 签名、有效期都对的临时 cookie 内容 */
function readFlowCookie(req, now = Date.now()) {
  const raw = cookieValue(req.headers?.cookie, flowCookieName(req));
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const want = hmac(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p === 'object' && p.exp > now ? p : null;
  } catch {
    return null;
  }
}

/** 回跳地址只收站内相对路径 */
export function safeReturnTo(raw, fallback = '/') {
  if (typeof raw !== 'string' || raw.length > 1000) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\r\n]/.test(raw)) return fallback;
  return raw;
}

/** 回跳地址里的错误码只放这些（前端按码显示）；别的一律归 provider_error，别把内部异常原样放进 URL */
const ERROR_CODES = new Set([
  'provider_unavailable', 'rate_limited', 'login_required', 'reauth_required', 'state_mismatch', 'access_denied', 'provider_error',
  'token_exchange_failed', 'profile_fetch_failed', 'session_changed', 'identity_taken', 'provider_already_linked', 'login_failed',
  'no_verified_email', 'mail_failed', 'register_rate_limited', 'registration_closed', 'email_taken',
]);
function errorCode(raw) {
  const c = String(raw || '').toLowerCase();
  return ERROR_CODES.has(c) ? c : 'provider_error';
}

/**
 * 登录流程失败 / 要输验证码时回哪一页：从别的页面发起的（比如桌面版登录确认页 /desktop-auth?…）回原页，
 * 未登录时 AuthGate 在任何路径都显示登录墙，错误照样显示、原页参数不丢；从首页发起的回 /login
 */
function loginPageFor(returnTo) {
  const r = typeof returnTo === 'string' ? returnTo.split('#')[0] : '';
  return r && r !== '/' ? r : '/login';
}

function withQuery(path, key, value) {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

/** 待确认关联：sha256(token) → { provider, subject, email, userId, exp, returnTo } */
const pendingLinks = new Map();

function sweepPending(now = Date.now()) {
  for (const [k, v] of pendingLinks) if (v.exp <= now) pendingLinks.delete(k);
}

const maskEmail = (e) => String(e).replace(/^(.)[^@]*(@.*)$/, '$1***$2');

/**
 * @param {import('express').Router} router  hostedAuthRouter
 * @param {{ registerQuota: { exhausted: Function, take: Function } }} deps
 */
export function mountOAuth(router, { registerQuota }) {
  router.get('/oauth/providers', (_req, res) => {
    res.json({ providers: enabledProviders() });
  });

  // 登录页 / 账号页要知道这个站开了哪些登录方式（09-13 第三批）。
  // emailAuth：邮箱注册、验证码登录、找回密码、绑定邮箱这几条要不要露给用户。SES 还在沙盒时真实邮箱收不到信，
  // 所以默认关，脱离沙盒后 .env 设 NODESIGN_EMAIL_AUTH=1 打开（接口本身一直在，只是界面不露）
  router.get('/methods', (_req, res) => {
    res.json({
      providers: enabledProviders(),
      emailAuth: process.env.NODESIGN_EMAIL_AUTH === '1',
      openRegistration: /^(1|true|yes)$/i.test(String(process.env.NODESIGN_OPEN_REGISTRATION || '')),
      // 找不回密码时的去处（没绑邮箱的用户名老账号；设计方案 §5.3）。没配就不显示
      supportEmail: /^[^\s@]+@[^\s@]+$/.test(String(process.env.NODESIGN_SUPPORT_EMAIL || '')) ? process.env.NODESIGN_SUPPORT_EMAIL : null,
    });
  });

  router.get('/oauth/:provider/start', async (req, res) => {
    const provider = String(req.params.provider);
    const intent = req.query.intent === 'link' ? 'link' : 'login';
    const returnTo = safeReturnTo(req.query.return, intent === 'link' ? '/settings' : '/');
    const fail = (code) => res.redirect(302, withQuery(intent === 'link' ? '/settings' : loginPageFor(returnTo), 'oauth_error', errorCode(code)));
    if (!PROVIDERS.includes(provider) || !providerEnabled(provider)) return fail('provider_unavailable');
    if (!startWindow.take(clientIp(req)).ok) return fail('rate_limited');

    let sid = null;
    if (intent === 'link') {
      // 关联 = 给这个号多开一扇门：偷到会话的人不能靠这一步长期占着号，所以要刚验证过身份
      const auth = requestAuth(req);
      const session = auth?.kind === 'session' ? getSession(auth.sessionId) : null;
      if (!session) return fail('login_required');
      if (!session.authenticated_at || Date.now() - session.authenticated_at >= RECENT_AUTH_MS) return fail('reauth_required');
      sid = session.id;
    }
    const begun = await beginAuthorization(req, provider);
    setFlowCookie(res, req, {
      p: provider, st: begun.state, cv: begun.codeVerifier, n: begun.nonce, i: intent, sid, r: returnTo, exp: Date.now() + FLOW_TTL_MS,
      // 回调地址一起签进去：生产和 exp 共用同一把服务端密钥，别让一边签的临时 cookie 在另一边通过（fable 09-13）
      ru: redirectUri(req, provider),
    });
    res.redirect(302, begun.url);
  });

  router.get('/oauth/:provider/callback', async (req, res) => {
    const provider = String(req.params.provider);
    const flow = readFlowCookie(req);
    res.setHeader('Set-Cookie', clearFlowCookie(req));   // 一次性：不管成败都清
    const errorPath = flow?.i === 'link' ? '/settings' : loginPageFor(flow?.r);
    const fail = (code) => res.redirect(302, withQuery(errorPath, 'oauth_error', errorCode(code)));
    if (!flow || flow.p !== provider || !PROVIDERS.includes(provider) || flow.ru !== redirectUri(req, provider)) return fail('state_mismatch');

    let identity;
    try {
      const url = new URL(req.originalUrl, 'http://callback.invalid');
      identity = await completeAuthorization(req, provider, url, { state: flow.st, codeVerifier: flow.cv, nonce: flow.n });
    } catch (err) {
      recordAuthEvent('oauth_fail', { req, detail: { provider, code: err.code || 'UNKNOWN' } });
      return fail(err.code);
    }

    const existing = findIdentity(provider, identity.subject);

    // ── 关联流程 ──
    if (flow.i === 'link') {
      const auth = requestAuth(req);
      if (!auth || auth.kind !== 'session' || auth.sessionId !== flow.sid) return fail('session_changed');
      if (existing && existing.user_id !== auth.user.id) return fail('identity_taken');
      try {
        linkIdentity({ provider, subject: identity.subject, userId: auth.user.id, email: identity.email });
      } catch (err) {
        return fail(err.code);
      }
      if (!existing) {
        noticeMailSafe({ to: auth.user.email, kind: 'identity_linked', locale: auth.user.locale });
        recordAuthEvent('identity_link', { userId: auth.user.id, req, detail: { provider } });
      }
      return res.redirect(302, withQuery(flow.r, 'linked', provider));
    }

    // ── 登录流程 ──
    const finishLogin = (user, method, event) => {
      startSession(res, { userId: user.id, req, method });   // 它会整个重写 Set-Cookie，清临时 cookie 那条要补回去
      res.setHeader('Set-Cookie', [...[].concat(res.getHeader('Set-Cookie') || []), clearFlowCookie(req)]);
      recordAuthEvent(event, { userId: user.id, req, detail: { provider } });
      return res.redirect(302, flow.r);
    };

    if (existing) {
      const user = getUserById(existing.user_id);
      if (!user || user.disabled) return fail('login_failed');
      return finishLogin(user, provider, 'login_ok');
    }

    if (!identity.email || !identity.emailVerified) return fail('no_verified_email');

    const owner = getUserByEmail(identity.email);
    if (owner) {
      if (owner.disabled) return fail('login_failed');
      // 可信邮箱且这个号没设密码（本来就是第三方登录的号）才自动关联。设了密码的号一律走验证码：
      // GitHub 没有 authoritative 信号，公司 / 学校邮箱被回收给新人时，旧主人的 GitHub 不该直接进新人的号（fable 09-13）
      if (identity.trustedEmail && !owner.hasPassword) {
        try {
          linkIdentity({ provider, subject: identity.subject, userId: owner.id, email: identity.email });
        } catch (err) {
          return fail(err.code);
        }
        noticeMailSafe({ to: owner.email, kind: 'identity_linked', locale: owner.locale });
        recordAuthEvent('identity_link', { userId: owner.id, req, detail: { provider, via: 'trusted_email' } });
        return finishLogin(owner, provider, 'login_ok');
      }
      // 这家对这个邮箱不 authoritative（Google 非 Gmail 且无 hd）：邮箱主人输验证码才关联
      sweepPending();
      const token = crypto.randomBytes(32).toString('base64url');
      pendingLinks.set(sha256(token), {
        provider, subject: identity.subject, email: identity.email, userId: owner.id, exp: Date.now() + FLOW_TTL_MS, returnTo: flow.r,
      });
      const sent = await sendCode(req, { email: identity.email, purpose: 'link', locale: owner.locale });
      if (!sent.ok) {
        pendingLinks.delete(sha256(token));
        return fail(sent.status === 429 ? 'rate_limited' : 'mail_failed');
      }
      // 放 # 片段里：浏览器不把片段发给服务器，不进 nginx / Cloudflare 的访问日志
      return res.redirect(302, `${loginPageFor(flow.r)}#oauth_pending=${token}`);
    }

    if (registerQuota.exhausted(req)) return fail('register_rate_limited');
    let user;
    try {
      user = registerViaOAuth({ email: identity.email, usernameSeed: identity.login || identity.name || identity.email });
      linkIdentity({ provider, subject: identity.subject, userId: user.id, email: identity.email });
    } catch (err) {
      return fail(err.code === 'BAD_INVITE' ? 'registration_closed' : err.code);
    }
    registerQuota.take(req);
    return finishLogin(user, provider, 'register');
  });

  router.post('/oauth/pending/lookup', (req, res) => {
    sweepPending();
    const hit = typeof req.body?.token === 'string' ? pendingLinks.get(sha256(req.body.token)) : null;
    if (!hit) return res.status(404).json({ error: msg(req, '第三方登录的确认已过期，请重新登录'), code: 'PENDING_EXPIRED' });
    res.json({ provider: hit.provider, email: maskEmail(hit.email) });
  });

  router.post('/oauth/pending/verify', (req, res) => {
    sweepPending();
    const key = sha256(typeof req.body?.token === 'string' ? req.body.token : '');
    const hit = pendingLinks.get(key);
    if (!hit) return res.status(404).json({ error: msg(req, '第三方登录的确认已过期，请重新登录'), code: 'PENDING_EXPIRED' });
    const v = verifyCode({ email: hit.email, purpose: 'link', code: req.body?.code });
    if (!v.ok) {
      const r = codeErrorResponse(req, v);
      return res.status(r.status).json(r.body);
    }
    pendingLinks.delete(key);
    const user = getUserById(hit.userId);
    if (!user || user.disabled || user.email !== hit.email) {
      return res.status(400).json({ error: msg(req, '第三方登录的确认已过期，请重新登录'), code: 'PENDING_EXPIRED' });
    }
    try {
      linkIdentity({ provider: hit.provider, subject: hit.subject, userId: user.id, email: hit.email });
    } catch {
      return res.status(409).json({ error: msg(req, '这个第三方账号已经关联了别的账号'), code: 'IDENTITY_TAKEN' });
    }
    noticeMailSafe({ to: user.email, kind: 'identity_linked', locale: user.locale });
    recordAuthEvent('identity_link', { userId: user.id, req, detail: { provider: hit.provider, via: 'email_code' } });
    startSession(res, { userId: user.id, req, method: hit.provider });
    recordAuthEvent('login_ok', { userId: user.id, req, detail: { provider: hit.provider } });
    res.json({ ok: true, user: publicUser(user), returnTo: hit.returnTo });
  });
}

/** 测试用 */
export function _resetOAuthState() {
  pendingLinks.clear();
}
