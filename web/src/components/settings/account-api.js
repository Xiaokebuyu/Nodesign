// web/src/components/settings/account-api.js — 「账号与安全」的请求封装与纯函数（09-13 auth-v2 第三批）
//
// 接口在 server/hosted/auth/account-routes.js（/api/me/account）和 oauth-routes.js（/api/auth/*）。
// 这里只放不碰 React 的东西：请求、UA 摘要、第三方回跳的查询串、时间与错误码的文案，
// 方便单测（account-api.test.js）。界面在 AccountSecurity.jsx。
import { t } from '../../lib/i18n.js';

/**
 * 发一个 JSON 请求。失败抛 Error：message 用服务端给的 error（已本地化，可直接给用户看），
 * 另挂 status / code，调用方按 code 分流（REAUTH_REQUIRED / SESSION_REFRESH_REQUIRED …）。
 */
export async function apiJson(method, url, body, fetchImpl = fetch) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetchImpl(url, init); } catch { throw Object.assign(new Error(t('网络错误，请重试')), { status: 0, code: 'NETWORK' }); }
  const j = await res.json().catch(() => ({}));
  // 登录已失效：跟 lib/api.js 的 jsonRequest 同一个出口，AuthGate 收到后回登录墙
  if (res.status === 401 && typeof window !== 'undefined' && j.code !== 'BAD_PASSWORD') window.dispatchEvent(new Event('nd:unauthorized'));
  if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status, code: j.code || null });
  return j;
}

export const AccountApi = {
  methods: () => apiJson('GET', '/api/auth/methods'),
  account: () => apiJson('GET', '/api/me/account'),
  sessions: () => apiJson('GET', '/api/me/account/sessions'),
  reauthPassword: (password) => apiJson('POST', '/api/me/account/reauth', { password }),
  reauthCodeStart: () => apiJson('POST', '/api/me/account/reauth/code/start', {}),
  reauthCodeVerify: (code) => apiJson('POST', '/api/me/account/reauth/code/verify', { code }),
  setPassword: (body) => apiJson('PUT', '/api/me/account/password', body),
  emailStart: (email) => apiJson('POST', '/api/me/account/email/start', { email }),
  emailVerify: (email, code) => apiJson('POST', '/api/me/account/email/verify', { email, code }),
  setUsername: (username) => apiJson('PUT', '/api/me/account/username', { username }),
  revokeSession: (id) => apiJson('DELETE', `/api/me/account/sessions/${encodeURIComponent(id)}`),
  revokeOthers: () => apiJson('POST', '/api/me/account/sessions/revoke-others', {}),
  unlink: (provider) => apiJson('DELETE', `/api/me/account/identities/${encodeURIComponent(provider)}`),
};

/** 关联第三方：整页跳转（服务端要求这条会话 5 分钟内验证过身份） */
export function linkStartUrl(provider) {
  return `/api/auth/oauth/${encodeURIComponent(provider)}/start?intent=link&return=${encodeURIComponent('/settings')}`;
}

const PROVIDER_LABEL = { google: 'Google', github: 'GitHub' };
export function providerLabel(p) {
  return PROVIDER_LABEL[p] || String(p || '');
}

/** 网页登录的方式（sessions.method）→ 给人看的说法；认不出的原样返回 */
export function sessionMethodLabel(method) {
  switch (method) {
    case 'password': return t('密码登录');
    case 'register': return t('注册后登录');
    case 'email_code': return t('验证码登录');
    case 'reset': return t('重置密码后登录');
    case 'legacy_upgrade': return t('旧版登录凭证');
    case 'google': case 'github': return t('{provider} 登录', { provider: providerLabel(method) });
    default: return method ? String(method) : '';
  }
}

/**
 * userAgent → 「Chrome · Windows」这种一眼能认的摘要。只认主流几家，认不出返回 ''（界面写「未知设备」）。
 * 顺序有讲究：Edge / Opera 的 UA 里也带 Chrome，Chrome 的 UA 里也带 Safari；iPad 的 UA 里带 Mac OS X，安卓的带 Linux。
 */
export function summarizeUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return '';
  let browser = '';
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Electron\//.test(s)) browser = 'Electron';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  let os = '';
  if (/iPhone|iPod/.test(s)) os = 'iOS';
  else if (/iPad/.test(s)) os = 'iPadOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return [browser, os].filter(Boolean).join(' · ');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 毫秒时间戳 → 一天之内说「N 分钟前」，更早的写本地时间 yyyy-mm-dd hh:mm */
export function formatLastSeen(ms, now = Date.now()) {
  const at = Number(ms);
  if (!at || !Number.isFinite(at)) return '';
  const diff = Math.max(0, now - at);
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('刚刚');
  if (m < 60) return t('{n} 分钟前', { n: m, count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('{n} 小时前', { n: h, count: h });
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 第三方关联回跳带回来的错误码 → 提示语。码表以 oauth-routes.js 的 ERROR_CODES 为准，认不出的给通用一句 */
export function oauthErrorMessage(code) {
  switch (code) {
    case 'reauth_required': return t('关联前需要验证身份，请验证后重新发起关联');
    case 'login_required': return t('登录状态已失效，请重新登录后再关联');
    case 'session_changed': return t('关联过程中登录状态发生了变化，请重新发起关联');
    case 'identity_taken': return t('该第三方账号已关联到其他账号');
    case 'provider_already_linked': return t('当前账号已关联过该服务的另一个账号，请先解除原有关联');
    case 'access_denied': return t('已取消授权');
    case 'state_mismatch': return t('授权请求已过期或无效，请重新发起关联');
    case 'token_exchange_failed': return t('未能完成授权，请稍后重试');
    case 'profile_fetch_failed': return t('未能读取第三方账号信息，请稍后重试');
    case 'provider_error': return t('第三方服务返回错误，请稍后重试');
    case 'provider_unavailable': return t('该登录方式暂未开放');
    case 'rate_limited': return t('操作过于频繁，请稍后重试');
    default: return t('关联未完成，请稍后重试');
  }
}

/**
 * 读关联回跳的查询串（?linked=google / ?oauth_error=xxx），并给出去掉这两个参数之后的查询串。
 * @returns {{ linked: string|null, error: string|null, search: string }} search 带前导 '?'，没有参数时为 ''
 */
export function readOAuthReturn(search) {
  const params = new URLSearchParams(String(search || ''));
  const linked = params.get('linked');
  const error = params.get('oauth_error');
  params.delete('linked');
  params.delete('oauth_error');
  const rest = params.toString();
  return { linked: linked || null, error: error || null, search: rest ? `?${rest}` : '' };
}

/** 服务端的「要先验证身份」 */
export const isReauthError = (e) => e?.code === 'REAUTH_REQUIRED';
