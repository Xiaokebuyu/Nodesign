/**
 * server/auth/session.js — 请求身份解析（内核半）
 *
 * ## 2026-09-13 auth-v2：会话改存服务端
 *
 * 旧形态是无状态 v2 token（`v2.<userId>.<exp>.<hmac>`，30 天，吊销不了）。新形态是服务端会话表
 * （hosted/auth/sessions-store.js），cookie 里放 `s1.<sessionId>.<secret>`。会话表的读写属于多用户站，
 * 住在 server/hosted/；内核不能 import hosted（check-client-boundary），所以 hosted 起动时通过
 * `installSessionBackend()` 把解析函数**注入**进来。本地分发版没有这一步，也不需要：登录墙钉死关闭。
 *
 * ## cookie 名为什么分 https / http
 *
 * 已发布站点在 `*.share.xiaobuyu.trade`，跟应用同站，站点脚本能写 `Domain=xiaobuyu.trade` 的同名 cookie，
 * 主站照收（下面的解析取第一个同名项）。`__Host-` 前缀的 cookie 浏览器禁止带 Domain 写入，这个面就关上了。
 * 但 `__Host-` 要求 Secure，只能在 https 上用。所以：
 *   - https 请求：只认 `__Host-<base>`；旧 v2 token 只在 NODESIGN_LEGACY_TOKEN_UNTIL 之前从 `<base>` 读（legacyAcceptedOn）
 *   - http 请求（本机开发、nginx 的 127.0.0.1:8081 看画布入口）：认 `<base>`
 * base 默认 `nd_auth`，exp 实例用 NODESIGN_SESSION_COOKIE 换名，免得同主机不同端口互相覆盖。
 *
 * ## 内部凭证
 *
 * 感知工具起的无头浏览器走 http://127.0.0.1，拿不到 `__Host-` cookie。它们用进程内签发的内部凭证
 * （internal-credentials.js，1 小时，不落库），cookie 名 `nd_internal`。
 */

import crypto from 'crypto';
import { getUserById, authEnabled, LOCAL_OWNER } from './users-store.js';
import { verifyInternalToken, INTERNAL_COOKIE } from './internal-credentials.js';

// 登录墙开关住 users-store（它要看 users 表 + profile），这里转出口给老调用点
export { authEnabled };

const LEGACY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // v2 token 的有效期，签发时间按 exp − 30 天反推

/** cookie 基名。exp 实例在 .env 设 NODESIGN_SESSION_COOKIE=nd_auth_exp */
export function cookieBaseName() {
  const v = String(process.env.NODESIGN_SESSION_COOKIE || '').trim();
  return /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : 'nd_auth';
}
/** 旧口径的名字（v2 token 与 http 下的会话都用它）。老调用点（探针脚本）还在 import */
export const COOKIE_NAME = 'nd_auth';

export function isSecureRequest(req) {
  return !!(req?.secure || req?.headers?.['x-forwarded-proto'] === 'https');
}

/** 这个请求上会话 cookie 该叫什么 */
export function sessionCookieName(req) {
  return isSecureRequest(req) ? `__Host-${cookieBaseName()}` : cookieBaseName();
}

let warnedDerivedSecret = false;
/** 服务端密钥（HMAC 用）。hosted 的验证码哈希、OAuth 临时 cookie 签名也从这里取 */
export function authSecret() {
  if (process.env.NODESIGN_AUTH_SECRET) return process.env.NODESIGN_AUTH_SECRET;
  if (!warnedDerivedSecret) {
    warnedDerivedSecret = true;
    console.warn('[auth] NODESIGN_AUTH_SECRET 未配置，从 NODESIGN_AUTH_PASSWORD 派生（建议在 .env 固定一个随机值）');
  }
  return crypto.createHash('sha256').update(`nd-auth-v2:${process.env.NODESIGN_AUTH_PASSWORD || ''}`).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', authSecret()).update(payload).digest('hex');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 旧 v2 token。线上路径已经不签发（登录一律建服务端会话）；留着给开发探针脚本（server/_probe-*.mjs）
 * 和过渡期的静默换发。
 */
export function mintToken(userId, now = Date.now()) {
  const payload = `v2.${userId}.${now + LEGACY_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns {{ userId: string, issuedAt: number } | null}（签名或过期不对 → null；v1 一律 null） */
export function verifyLegacyToken(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const m = token.match(/^(v2\.([A-Za-z0-9_-]{1,64})\.(\d{1,16}))\.([0-9a-f]{64})$/);
  if (!m) return null;
  const [, payload, userId, expStr, mac] = m;
  const exp = Number(expStr);
  if (exp < now) return null;
  if (!timingSafeEq(mac, sign(payload))) return null;
  return { userId, issuedAt: exp - LEGACY_TTL_MS };
}

/** 老接口：只要 userId */
export function verifyToken(token, now = Date.now()) {
  return verifyLegacyToken(token, now)?.userId ?? null;
}

/** 从原始 Cookie header 取某个名字的值（不引 cookie-parser 依赖）。同名多个时取第一个 */
export function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** 老接口 */
export function tokenFromCookieHeader(cookieHeader) {
  return cookieValue(cookieHeader, COOKIE_NAME);
}

// ── hosted 注入的会话后端 ──

/**
 * @typedef {object} AuthResult
 * @property {object} user
 * @property {string|null} sessionId   服务端会话 id；内部凭证 / 旧 token / 本地版为 null
 * @property {'session'|'legacy'|'internal'|'local'} kind
 * @property {(res: import('http').ServerResponse) => void} [onResponse]  需要写 cookie 时（续期 / 旧 token 换发）
 */
let backend = null;

/**
 * hosted/mount.js 起动时调一次。
 * @param {{ resolve: (req) => AuthResult|null, logout?: (req, res) => void }} impl
 */
export function installSessionBackend(impl) {
  backend = impl;
}

/** 测试用 */
export function _resetSessionBackend() {
  backend = null;
}

/**
 * https 下旧 v2 token 认到什么时候（NODESIGN_LEGACY_TOKEN_UNTIL，ISO 时间）。不设 = https 下不认。
 *
 * 为什么要有期限：旧 token 住在不带前缀的 `nd_auth` 里，`*.share` 子域的发布页能往这个名字投 cookie
 * （Domain=xiaobuyu.trade）。攻击者拿自己上线前的 v2 token 投进去，没登录的访客就会被换发成攻击者账号的会话
 * （fable 09-13 代码评审）。这个面只能靠缩短过渡期收窄，所以期限必须显式配置。
 * http（本机开发、127.0.0.1:8081 看画布入口）不受限：那些主机名不在 xiaobuyu.trade 下，子域投不进来。
 */
export function legacyAcceptedOn(req, now = Date.now()) {
  if (!isSecureRequest(req)) return true;
  const until = Date.parse(String(process.env.NODESIGN_LEGACY_TOKEN_UNTIL || ''));
  return Number.isFinite(until) && now < until;
}

function legacyAuth(req) {
  if (!legacyAcceptedOn(req)) return null;
  const hit = verifyLegacyToken(cookieValue(req.headers?.cookie, cookieBaseName()));
  if (!hit) return null;
  const user = getUserById(hit.userId);
  if (!user || user.disabled) return null;
  // 「全部下线」之前签的 v2 一律不认（它没有会话行可以吊销，只能按时间判）
  if (user.sessionsValidAfter && hit.issuedAt < Date.parse(user.sessionsValidAfter)) return null;
  return { user, sessionId: null, kind: 'legacy' };
}

/**
 * HTTP / WS upgrade 共用：解析请求身份。
 * @returns {AuthResult|null}
 */
export function requestAuth(req) {
  if (!authEnabled()) return { user: LOCAL_OWNER, sessionId: null, kind: 'local' };
  const internal = verifyInternalToken(cookieValue(req.headers?.cookie, INTERNAL_COOKIE));
  if (internal) {
    const user = getUserById(internal.userId);
    return user && !user.disabled ? { user, sessionId: null, kind: 'internal' } : null;
  }
  if (backend) return backend.resolve(req);
  // 没装后端（脚本、单测直接起内核）：只认旧 token，走 http 名
  return legacyAuth(req);
}

/**
 * @returns {object|null} user（登录墙关闭时返回匿名 admin，guard 全放行）
 */
export function requestUser(req) {
  return requestAuth(req)?.user ?? null;
}

/** 布尔兼容口（老调用点）：有有效身份即 true */
export function requestAuthed(req) {
  return !!requestUser(req);
}

/** hosted 的会话后端用：旧 token 解析（带 sessions_valid_after 判据） */
export { legacyAuth as resolveLegacyAuth };

/** 退出登录：有后端交给后端（吊销会话行），否则只清 cookie */
export function logoutRequest(req, res) {
  if (backend?.logout) return backend.logout(req, res);
  res.setHeader('Set-Cookie', cookieClear(req));
}

export function cookieSerialize(token, req, maxAgeSec = Math.floor(LEGACY_TTL_MS / 1000)) {
  const attrs = [
    `${sessionCookieName(req)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * 清旧名 cookie 的 Set-Cookie 列表：本主机那份 + 父域那份（NODESIGN_COOKIE_PARENT_DOMAIN，如 xiaobuyu.trade）。
 * 父域那份是子域发布页可能投进来的，只清本主机的删不掉它。投的人换个 Path 还能再投，这只是尽量清，
 * 真正的闸是 legacyAcceptedOn 的期限。
 */
export function legacyCookieClears() {
  const base = cookieBaseName();
  const out = [`${base}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
  const parent = String(process.env.NODESIGN_COOKIE_PARENT_DOMAIN || '').trim();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parent)) out.push(`${base}=; Domain=${parent}; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return out;
}

/** 清掉这个请求上的会话 cookie；https 下连旧名一起清（过渡期换发后不留两份） */
export function cookieClear(req) {
  if (!isSecureRequest(req)) return [`${cookieBaseName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
  return [`__Host-${cookieBaseName()}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`, ...legacyCookieClears()];
}
