/**
 * server/hosted/auth/sessions-store.js — 网页登录会话（服务端存储，可逐条吊销）
 *
 * cookie 值 `s1.<sessionId>.<secret>`：sessionId 明文用来直接查行，secret 只存 sha256，比对走 timingSafeEqual
 * （同 relay/devices.js 的令牌形状）。有效期 30 天滑动续期：last_seen 每 5 分钟最多写一次，写的同时把
 * expires_at 往后推、给浏览器重发一次 cookie。
 *
 * authenticated_at：这条会话**真正验过身份**的时间（密码、验证码、第三方登录、重新验证）。
 * 旧 v2 token 静默换发出来的会话这一列是 null —— 偷到旧 token 的人不能靠换发拿到「刚登录过」，
 * 进而去改邮箱、改密码（account-routes.js 的 recentAuth 判据）。
 *
 * 由 hosted/mount.js 通过 session.installSessionBackend 注入内核。
 */

import crypto from 'node:crypto';
import db from '../../engine/runs/store.js';
import { getUserById, invalidateUserCache } from '../../auth/users-store.js';
import {
  cookieValue, sessionCookieName, cookieBaseName, isSecureRequest,
  cookieSerialize, cookieClear, resolveLegacyAuth, legacyCookieClears,
} from '../../auth/session.js';
import { revokeInternalTokensFor } from '../../auth/internal-credentials.js';
import { closeUserSockets } from '../../ws/auth-sockets.js';
import { clientIp } from './client-ip.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    authenticated_at INTEGER,
    method TEXT,
    ip TEXT,
    user_agent TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
`);

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const PREFIX = 's1.';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 建一条会话。**明文只在返回值里出现一次**。
 * @param {{ userId: string, req: object, method: string, authenticated?: boolean }} opts
 *   method：password / email_code / google / github / register / reset / legacy_upgrade
 */
export function createSession({ userId, req, method, authenticated = true, now = Date.now() }) {
  if (!userId) throw new Error('createSession: userId 必填');
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const ua = String(req?.headers?.['user-agent'] || '').slice(0, 300) || null;
  db.prepare(`INSERT INTO auth_sessions (id, user_id, secret_hash, created_at, last_seen_at, expires_at, authenticated_at, method, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, sha256(secret), now, now, now + SESSION_TTL_MS, authenticated ? now : null, method, clientIp(req), ua);
  return { sessionId: id, token: `${PREFIX}${id}.${secret}` };
}

/**
 * 建会话 + 写 cookie（https 下是 `__Host-` 名，顺手清掉旧名）。
 * 请求上已经带着一条有效会话（同一个浏览器换号登录 / 重复登录）：先吊销它，别在会话列表里留幽灵行。
 */
export function startSession(res, opts) {
  const prior = verifySessionToken(cookieValue(opts.req?.headers?.cookie, sessionCookieName(opts.req)));
  if (prior) revokeSession(prior.session.id);
  const { sessionId, token } = createSession(opts);
  const cookies = [cookieSerialize(token, opts.req, Math.floor(SESSION_TTL_MS / 1000))];
  if (isSecureRequest(opts.req)) cookies.push(...legacyCookieClears());
  res.setHeader('Set-Cookie', cookies);
  return sessionId;
}

export function getSession(id) {
  return db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) || null;
}

function parseToken(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const dot = token.indexOf('.', PREFIX.length);
  if (dot < 0) return null;
  const id = token.slice(PREFIX.length, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f]{16}$/.test(id) || !secret) return null;
  return { id, secret };
}

/**
 * 核验 cookie 里的会话。不区分失败原因（同 devices.verifyDeviceToken）。
 * @returns {{ session: object, user: object, shouldRefresh: boolean } | null}
 */
export function verifySessionToken(token, now = Date.now()) {
  const p = parseToken(token);
  if (!p) return null;
  const row = getSession(p.id);
  if (!row || row.revoked_at || row.expires_at <= now) return null;
  const want = Buffer.from(row.secret_hash, 'utf8');
  const got = Buffer.from(sha256(p.secret), 'utf8');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const user = getUserById(row.user_id);
  if (!user || user.disabled) return null;
  let shouldRefresh = false;
  if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, now + SESSION_TTL_MS, row.id);
    shouldRefresh = true;
  }
  return { session: row, user, token, shouldRefresh };
}

export function markAuthenticated(sessionId, now = Date.now()) {
  db.prepare('UPDATE auth_sessions SET authenticated_at = ? WHERE id = ?').run(now, sessionId);
}

/** 列某账号仍有效的会话（账号页） */
export function listActiveSessions(userId, now = Date.now()) {
  return db.prepare(`SELECT id, created_at, last_seen_at, expires_at, method, ip, user_agent FROM auth_sessions
                     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`).all(userId, now);
}

/** 吊销一条会话 + 断开它建的 WebSocket */
export function revokeSession(sessionId, now = Date.now()) {
  const row = getSession(sessionId);
  if (!row || row.revoked_at) return false;
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, sessionId);
  closeUserSockets(row.user_id, { sessionId });
  return true;
}

/**
 * 吊销某账号的网页登录。exceptSessionId 给了就保留那一条（「退出其他设备」「改密码」），不给就全部下线
 * （找回密码、停用）。同时：旧 v2 token 按 sessions_valid_after 一刀切、进程内的内部凭证清掉、
 * 已打开的 WebSocket 断开。桌面设备令牌不在这里，要吊的话调用方另调 revokeAllDevices。
 * @returns {number} 吊销的会话行数
 */
export function revokeUserSessions(userId, { exceptSessionId = null, now = Date.now() } = {}) {
  const r = exceptSessionId
    ? db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?').run(now, userId, exceptSessionId)
    : db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
  db.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
  invalidateUserCache(userId);
  revokeInternalTokensFor(userId);
  closeUserSockets(userId, exceptSessionId ? { exceptSessionId } : {});
  return r.changes;
}

/** 注入内核的解析函数（session.installSessionBackend） */
export function resolveRequest(req) {
  const hit = verifySessionToken(cookieValue(req.headers?.cookie, sessionCookieName(req)));
  if (hit) {
    return {
      user: hit.user,
      sessionId: hit.session.id,
      kind: 'session',
      session: hit.session,
      onResponse: hit.shouldRefresh
        ? (res) => { if (!res.headersSent) res.setHeader('Set-Cookie', cookieSerialize(hit.token, req, Math.floor(SESSION_TTL_MS / 1000))); }
        : undefined,
    };
  }
  // 过渡期：旧 v2 token（同名 cookie 在 https 下是旧名，http 下同名）。认得出来就换发成服务端会话，
  // 换发出来的会话不算「刚验证过身份」。v2 最迟 30 天后自然全部过期，届时删掉这一段。
  const legacy = resolveLegacyAuth(req);
  if (!legacy) return null;
  return {
    ...legacy,
    onResponse: (res) => {
      if (res.headersSent) return;
      // 一次页面加载会并发打好几个接口，每个都带着旧 cookie：同一枚旧 token 一分钟内只换发一条会话，其余请求复用
      const key = sha256(cookieValue(req.headers?.cookie, cookieBaseName()) || '');
      const now = Date.now();
      for (const [k, v] of legacyUpgrades) if (now - v.at > 60_000) legacyUpgrades.delete(k);
      let hit = legacyUpgrades.get(key);
      if (!hit) {
        hit = { ...createSession({ userId: legacy.user.id, req, method: 'legacy_upgrade', authenticated: false }), at: now };
        legacyUpgrades.set(key, hit);
      }
      res.setHeader('Set-Cookie', [
        cookieSerialize(hit.token, req, Math.floor(SESSION_TTL_MS / 1000)),
        ...(isSecureRequest(req) ? legacyCookieClears() : []),
      ]);
    },
  };
}

/** 旧 token 的哈希 → 刚换发的会话（明文只在内存里停一分钟） */
const legacyUpgrades = new Map();

export function logoutRequest(req, res) {
  const hit = verifySessionToken(cookieValue(req.headers?.cookie, sessionCookieName(req)));
  if (hit) {
    revokeSession(hit.session.id);
  } else {
    // 过渡期旧 token 登录的：没有会话行可吊，至少把它建的连接断掉（浏览器共视通道能注入键鼠）
    const legacy = resolveLegacyAuth(req);
    if (legacy) closeUserSockets(legacy.user.id, { sessionId: null });
  }
  res.setHeader('Set-Cookie', cookieClear(req));
}
