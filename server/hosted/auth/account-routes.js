/**
 * server/hosted/auth/account-routes.js — 「账号与安全」接口（/api/me/account，authGuard 之后）
 *
 *   GET    /                       邮箱、有没有密码、这条会话是否「刚验证过身份」
 *   POST   /reauth                 { password }              → 重新验证身份（有密码的号）
 *   POST   /reauth/code/start                                → 往账号邮箱发验证码（没密码的号）
 *   POST   /reauth/code/verify     { code }                  → 重新验证身份
 *   PUT    /password               { currentPassword?, newPassword }  → 改密码，其他网页会话下线
 *   POST   /email/start            { email }                 → 往新邮箱发验证码（要刚验证过身份）
 *   POST   /email/verify           { email, code }           → 绑定 / 更换邮箱，通知发到旧地址
 *   PUT    /username               { username }
 *   GET    /sessions                                         → 网页登录列表（桌面设备在 /api/me/devices）
 *   DELETE /sessions/:id
 *   POST   /sessions/revoke-others                           → 退出其他所有网页登录 + 所有桌面设备（要刚验证过身份）
 *
 * 「刚验证过身份」= 这条会话 5 分钟内用密码 / 验证码 / 第三方登录验过身份（sessions-store 的 authenticated_at）。
 * 换邮箱之所以也要它：绑一个自己的邮箱 = 拿到找回密码的能力，偷到会话的人不能靠这一步把号彻底抢走。
 */

import express from 'express';
import { getUserById, normalizeEmail, getUserByEmail } from '../../auth/users-store.js';
import { publicUser } from '../../auth/middleware.js';
import { cookieClear } from '../../auth/session.js';
import { originAllowed } from '../../auth/origin-guard.js';
import { msg } from '../../shared/messages.js';
import { setPassword, setEmail, setUsername } from '../users-write.js';
import { checkPassword } from '../auth-routes.js';
import { verifyCode } from './email-codes.js';
import { sendCode, codeErrorResponse, passwordErrorResponse, noticeMailSafe } from './code-mail.js';
import { checkNewPassword } from './password-policy.js';
import { listActiveSessions, getSession, revokeSession, revokeUserSessions, markAuthenticated } from './sessions-store.js';
import { revokeUserDevices } from '../relay/devices.js';
import { recordAuthEvent } from './audit.js';

export const RECENT_AUTH_MS = 5 * 60 * 1000;

function currentSession(req) {
  return req.auth?.kind === 'session' && req.auth.sessionId ? getSession(req.auth.sessionId) : null;
}

export function recentlyAuthenticated(req, now = Date.now()) {
  const s = currentSession(req);
  return !!(s?.authenticated_at && now - s.authenticated_at < RECENT_AUTH_MS);
}

function send(res, r) {
  return res.status(r.status).json(r.body);
}

/**
 * 核对当前账号的密码。走 auth-routes 的 checkPassword（按 IP + 按账号的爆破锁），偷到会话的人不能在这里无限试密码。
 * 用本账号的邮箱（没有就用户名）去查凭据，再确认查到的就是这个号。
 * @returns {{ ok: true } | { ok: false, status: number }}
 */
function checkOwnPassword(req, user, password) {
  const r = checkPassword(req, user.email || user.username, password);
  return r.ok && r.userId === user.id ? { ok: true } : { ok: false, status: r.status === 429 ? 429 : 401 };
}

function needSession(req, res) {
  if (currentSession(req)) return false;
  // 旧 token 刚被换发成会话的那一次请求、或内部凭证：让前端刷新一下再来
  res.status(409).json({ error: msg(req, '登录状态刚刚更新，请刷新页面后再试'), code: 'SESSION_REFRESH_REQUIRED' });
  return true;
}

function needRecentAuth(req, res) {
  if (needSession(req, res)) return true;
  if (recentlyAuthenticated(req)) return false;
  res.status(403).json({ error: msg(req, '请先验证身份'), code: 'REAUTH_REQUIRED' });
  return true;
}

const router = express.Router();

router.use((req, res, next) => {
  if (req.method !== 'GET' && !originAllowed(req)) return res.status(403).json({ error: 'forbidden origin', code: 'FORBIDDEN_ORIGIN' });
  next();
});

router.get('/', (req, res) => {
  const user = getUserById(req.user.id);
  res.json({ user: publicUser(user), emailVerifiedAt: user.emailVerifiedAt, recentAuth: recentlyAuthenticated(req), sessionId: req.auth?.sessionId ?? null });
});

router.post('/reauth', (req, res) => {
  if (needSession(req, res)) return;
  const check = checkOwnPassword(req, getUserById(req.user.id), req.body?.password);
  if (!check.ok) {
    recordAuthEvent('reauth_fail', { userId: req.user.id, req });
    return res.status(check.status).json({ error: msg(req, '密码不对'), code: 'BAD_PASSWORD' });
  }
  markAuthenticated(req.auth.sessionId);
  res.json({ ok: true });
});

router.post('/reauth/code/start', async (req, res) => {
  if (needSession(req, res)) return;
  const user = getUserById(req.user.id);
  if (!user.email) return res.status(400).json({ error: msg(req, '这个账号还没有绑定邮箱'), code: 'NO_EMAIL' });
  const r = await sendCode(req, { email: user.email, purpose: 'reauth', locale: user.locale });
  if (!r.ok) return send(res, r);
  res.json({ ok: true, email: user.email });
});

router.post('/reauth/code/verify', (req, res) => {
  if (needSession(req, res)) return;
  const user = getUserById(req.user.id);
  if (!user.email) return res.status(400).json({ error: msg(req, '这个账号还没有绑定邮箱'), code: 'NO_EMAIL' });
  const v = verifyCode({ email: user.email, purpose: 'reauth', code: req.body?.code });
  if (!v.ok) return send(res, codeErrorResponse(req, v));
  markAuthenticated(req.auth.sessionId);
  res.json({ ok: true });
});

router.put('/password', (req, res) => {
  if (needSession(req, res)) return;
  const user = getUserById(req.user.id);
  const { currentPassword, newPassword } = req.body || {};
  if (user.hasPassword) {
    const check = checkOwnPassword(req, user, currentPassword);
    if (!check.ok) {
      recordAuthEvent('password_change_fail', { userId: user.id, req });
      return res.status(check.status).json({ error: msg(req, '当前密码不对'), code: 'BAD_PASSWORD' });
    }
  } else if (needRecentAuth(req, res)) {
    return;
  }
  const pw = checkNewPassword(newPassword, { email: user.email, username: user.username });
  if (!pw.ok) return send(res, passwordErrorResponse(req, pw.code));
  setPassword(user.id, newPassword);
  const revoked = revokeUserSessions(user.id, { exceptSessionId: req.auth.sessionId });
  markAuthenticated(req.auth.sessionId);
  noticeMailSafe({ to: user.email, kind: 'password_changed', locale: user.locale });
  recordAuthEvent('password_change', { userId: user.id, req, detail: { sessionsRevoked: revoked, hadPassword: user.hasPassword } });
  res.json({ ok: true, sessionsRevoked: revoked });
});

router.post('/email/start', async (req, res) => {
  if (needRecentAuth(req, res)) return;
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: msg(req, '邮箱格式不对'), code: 'BAD_EMAIL' });
  const owner = getUserByEmail(email);
  if (owner && owner.id !== req.user.id) return res.status(409).json({ error: msg(req, '这个邮箱已经注册过了'), code: 'EMAIL_TAKEN' });
  if (owner) return res.status(400).json({ error: msg(req, '这就是当前绑定的邮箱'), code: 'EMAIL_UNCHANGED' });
  const r = await sendCode(req, { email, purpose: 'verify_email', payload: { userId: req.user.id }, locale: req.user.locale });
  if (!r.ok) return send(res, r);
  res.json({ ok: true, email });
});

router.post('/email/verify', (req, res) => {
  if (needRecentAuth(req, res)) return;
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: msg(req, '邮箱格式不对'), code: 'BAD_EMAIL' });
  const v = verifyCode({ email, purpose: 'verify_email', code: req.body?.code });
  if (!v.ok) return send(res, codeErrorResponse(req, v));
  if (v.payload?.userId !== req.user.id) return send(res, codeErrorResponse(req, { code: 'CODE_INVALID' }));
  const before = getUserById(req.user.id);
  let user;
  try {
    user = setEmail(req.user.id, email);
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return res.status(409).json({ error: msg(req, '这个邮箱已经注册过了'), code: 'EMAIL_TAKEN' });
    return res.status(400).json({ error: msg(req, '邮箱格式不对'), code: 'BAD_EMAIL' });
  }
  if (before.email) noticeMailSafe({ to: before.email, kind: 'email_changed', locale: user.locale });
  else noticeMailSafe({ to: email, kind: 'email_added', locale: user.locale });
  recordAuthEvent('email_change', { userId: user.id, req, detail: { hadEmail: !!before.email } });
  res.json({ ok: true, user: publicUser(user) });
});

router.put('/username', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  try {
    const user = setUsername(req.user.id, username);
    recordAuthEvent('username_change', { userId: user.id, req });
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    if (err.code === 'USERNAME_TAKEN') return res.status(409).json({ error: msg(req, '用户名已被使用'), code: err.code });
    res.status(400).json({ error: msg(req, '用户名 2-32 位，仅限字母数字下划线连字符和中文'), code: 'BAD_USERNAME' });
  }
});

router.get('/sessions', (req, res) => {
  const current = req.auth?.sessionId ?? null;
  res.json({
    sessions: listActiveSessions(req.user.id).map((s) => ({
      id: s.id, current: s.id === current, method: s.method, ip: s.ip, userAgent: s.user_agent,
      createdAt: s.created_at, lastSeenAt: s.last_seen_at,
    })),
  });
});

router.delete('/sessions/:id', (req, res) => {
  const s = getSession(String(req.params.id));
  // 不是自己的当不存在
  if (!s || s.user_id !== req.user.id || s.revoked_at) return res.status(404).json({ error: msg(req, '没有这条登录记录'), code: 'NOT_FOUND' });
  revokeSession(s.id);
  recordAuthEvent('session_revoke', { userId: req.user.id, req, detail: { current: s.id === req.auth?.sessionId } });
  if (s.id === req.auth?.sessionId) res.setHeader('Set-Cookie', cookieClear(req));
  res.json({ ok: true });
});

router.post('/sessions/revoke-others', (req, res) => {
  if (needRecentAuth(req, res)) return;
  const sessions = revokeUserSessions(req.user.id, { exceptSessionId: req.auth.sessionId });
  const devices = revokeUserDevices(req.user.id);
  recordAuthEvent('sessions_revoke', { userId: req.user.id, req, detail: { sessions, devices } });
  res.json({ ok: true, sessionsRevoked: sessions, devicesRevoked: devices });
});

export default router;
