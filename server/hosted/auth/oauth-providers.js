/**
 * server/hosted/auth/oauth-providers.js — Google / GitHub 授权码 + PKCE 的协议部分（oauth4webapi）
 *
 * 环境变量（没配的那家不出现在登录页）：
 *   NODESIGN_GOOGLE_CLIENT_ID / NODESIGN_GOOGLE_CLIENT_SECRET
 *   NODESIGN_GITHUB_CLIENT_ID / NODESIGN_GITHUB_CLIENT_SECRET
 *   NODESIGN_PUBLIC_ORIGIN   回调地址用的站点地址（生产 https://nodesign.xiaobuyu.trade，exp 带 :8443）
 *
 * 取回来的身份统一成 { provider, subject, email, emailVerified, trustedEmail, name, login }：
 *   - Google：ID token 直接从令牌端点经 TLS 取得，按 OIDC Core 3.1.3.7 不验签名；oauth4webapi 校验 iss / aud / exp / nonce
 *   - GitHub：/user 取数字 id，/user/emails 取 primary 且 verified 的邮箱（/user 里的 email 只是公开邮箱，可能为空）
 *
 * trustedEmail = 这家对这个邮箱是否 authoritative，决定能不能按邮箱**自动**关联已有账号（设计方案 §5.6）：
 *   - Google：@gmail.com，或 email_verified 为真且带 hd（Google 官方的 authoritative 规则）
 *   - GitHub：primary 且 verified（GitHub 没有 Google 那种 authoritative 信号，旧邮箱被回收的风险另在 oauth-routes 里收窄）
 *
 * 邮箱过 normalizeEmail：不合我们形状（非 ASCII 等）的一律当作没有邮箱，走「没有已验证邮箱」拒绝，不建无邮箱无密码的号。
 */

import * as oauth from 'oauth4webapi';
import { normalizeEmail } from '../../auth/users-store.js';

const ENDPOINTS = {
  google: {
    as: {
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
    },
    scope: 'openid email profile',
  },
  github: {
    as: {
      issuer: 'https://github.com',
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
    },
    api: 'https://api.github.com',
    scope: 'read:user user:email',
  },
};

/** 测试用：把端点换成本机假服务 */
let overrides = null;
export function _setProviderOverrides(o) {
  overrides = o;
}

function endpoints(provider) {
  const base = ENDPOINTS[provider];
  const o = overrides?.[provider];
  return o ? { ...base, ...o, as: { ...base.as, ...(o.as || {}) } } : base;
}

function credentials(provider, env = process.env) {
  const id = env[`NODESIGN_${provider.toUpperCase()}_CLIENT_ID`];
  const secret = env[`NODESIGN_${provider.toUpperCase()}_CLIENT_SECRET`];
  return id && secret ? { id, secret } : null;
}

export function providerEnabled(provider) {
  return !!(ENDPOINTS[provider] && credentials(provider));
}

export function enabledProviders() {
  return Object.keys(ENDPOINTS).filter(providerEnabled);
}

export function publicOrigin(req) {
  const env = String(process.env.NODESIGN_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/]+$/.test(env)) return env;
  const proto = req?.secure || req?.headers?.['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req?.headers?.host}`;
}

export function redirectUri(req, provider) {
  return `${publicOrigin(req)}/api/auth/oauth/${provider}/callback`;
}

const requestOptions = () => (overrides?.insecure ? { [oauth.allowInsecureRequests]: true } : {});

/**
 * 生成跳转到服务商的地址 + 需要存进临时 cookie 的一次性值。
 * @returns {Promise<{ url: string, state: string, codeVerifier: string, nonce: string|null }>}
 */
export async function beginAuthorization(req, provider) {
  const ep = endpoints(provider);
  const cred = credentials(provider);
  if (!cred) throw Object.assign(new Error(`${provider} not configured`), { code: 'PROVIDER_DISABLED' });
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = provider === 'google' ? oauth.generateRandomNonce() : null;
  const url = new URL(ep.as.authorization_endpoint);
  url.searchParams.set('client_id', cred.id);
  url.searchParams.set('redirect_uri', redirectUri(req, provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ep.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (nonce) {
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('prompt', 'select_account');
  }
  if (provider === 'github') url.searchParams.set('allow_signup', 'true');
  return { url: url.href, state, codeVerifier, nonce };
}

/**
 * 回调：校验 state、用授权码 + PKCE 换令牌、取身份。任何一步不对抛带 code 的 Error。
 * @param {URL} callbackUrl  完整回调地址（含 code / state / error）
 */
export async function completeAuthorization(req, provider, callbackUrl, { state, codeVerifier, nonce }) {
  const ep = endpoints(provider);
  const cred = credentials(provider);
  if (!cred) throw Object.assign(new Error(`${provider} not configured`), { code: 'PROVIDER_DISABLED' });
  const client = { client_id: cred.id };
  const clientAuth = oauth.ClientSecretPost(cred.secret);

  let params;
  try {
    params = oauth.validateAuthResponse(ep.as, client, callbackUrl, state);
  } catch (err) {
    const code = err instanceof oauth.AuthorizationResponseError
      ? (err.error === 'access_denied' ? 'ACCESS_DENIED' : 'PROVIDER_ERROR')
      : 'STATE_MISMATCH';
    throw Object.assign(new Error(err.message), { code });
  }

  let tokens;
  try {
    const response = await oauth.authorizationCodeGrantRequest(ep.as, client, clientAuth, params, redirectUri(req, provider), codeVerifier, requestOptions());
    const opts = provider === 'google' ? { expectedNonce: nonce, requireIdToken: true } : {};
    const spare = provider === 'google' ? response.clone() : null;
    try {
      tokens = await oauth.processAuthorizationCodeResponse(ep.as, client, response, opts);
    } catch (err) {
      // Google 文档：ID token 的 iss 是 https://accounts.google.com 或 accounts.google.com 两种写法之一，
      // oauth4webapi 严格相等比较，第一种对不上时拿备用的副本按第二种再验一次（fable 09-13）
      if (!(spare && err.code === oauth.JWT_CLAIM_COMPARISON && err.cause?.claim === 'iss' && err.cause?.claims?.iss === 'accounts.google.com')) throw err;
      tokens = await oauth.processAuthorizationCodeResponse({ ...ep.as, issuer: 'accounts.google.com' }, client, spare, opts);
    }
  } catch (err) {
    throw Object.assign(new Error(`token exchange failed: ${err.message}`), { code: 'TOKEN_EXCHANGE_FAILED' });
  }

  if (provider === 'google') {
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : null;
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    const trustedEmail = !!(email && emailVerified && (email.endsWith('@gmail.com') || typeof claims.hd === 'string'));
    if (typeof claims.sub !== 'string' || !claims.sub) throw Object.assign(new Error('ID token without sub'), { code: 'TOKEN_EXCHANGE_FAILED' });
    return {
      provider, subject: String(claims.sub), email, emailVerified, trustedEmail,
      name: typeof claims.name === 'string' ? claims.name : null, login: null,
    };
  }

  // GitHub
  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'NoDesign' };
  const get = async (path) => {
    const r = await fetch(`${ep.api}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw Object.assign(new Error(`GitHub ${path} ${r.status}`), { code: 'PROFILE_FETCH_FAILED' });
    return r.json();
  };
  const user = await get('/user');
  // id 是 GitHub 账号的唯一标识：缺了就不能往下走，否则所有缺 id 的人会被当成同一个 subject（fable 09-13）
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw Object.assign(new Error('GitHub /user without numeric id'), { code: 'PROFILE_FETCH_FAILED' });
  const emails = await get('/user/emails');
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
  const email = primary?.email ? normalizeEmail(primary.email) : null;
  return {
    provider, subject: String(user.id), email, emailVerified: !!email, trustedEmail: !!email,
    name: typeof user.name === 'string' ? user.name : null, login: typeof user.login === 'string' ? user.login : null,
  };
}
