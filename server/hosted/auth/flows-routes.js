/**
 * server/hosted/auth/flows-routes.js — 没登录时的邮箱流程（挂在 /api/auth，authGuard 之前）
 *
 *   POST /identify                 { identifier }            → 这个登录名下一步该走什么（先输邮箱再分流的登录页用）
 *   POST /register/start           { email, password, inviteCode? } → 发注册验证码（验证通过才建号）
 *   POST /register/verify          { email, code }           → 建号 + 登录
 *   POST /login/code/start         { email }                 → 发登录验证码
 *   POST /login/code/verify        { email, code }           → 登录
 *   POST /password/forgot/start    { email }                 → 发找回密码验证码
 *   POST /password/forgot/verify   { email, code }           → 换一枚一次性重设令牌（10 分钟）
 *   POST /password/reset           { resetToken, password }  → 设新密码，所有设备下线，登录
 *
 * 「邮箱是否已注册」会被 identify 与这几个接口暴露：先输邮箱再分流的登录页本身就要这个信息
 * （OpenAI、GitHub 同样如此），用 identify 的 IP 限频和验证码的发送限频控制批量探测。
 */

import crypto from 'node:crypto';
import { getUserByEmail, normalizeEmail, openRegistrationEnabled } from '../../auth/users-store.js';
import { publicUser } from '../../auth/middleware.js';
import { hashPassword, precheckSignup, registerWithEmail, setPassword } from '../users-write.js';
import { makeRateWindow } from '../../lib/rate-window.js';
import { msg } from '../../shared/messages.js';
import { clientIp } from './client-ip.js';
import { verifyCode } from './email-codes.js';
import { sendCode, codeErrorResponse, passwordErrorResponse, noticeMailSafe } from './code-mail.js';
import { checkNewPassword } from './password-policy.js';
import { startSession, revokeUserSessions } from './sessions-store.js';
import { revokeUserDevices } from '../relay/devices.js';
import { recordAuthEvent } from './audit.js';

const identifyWindow = makeRateWindow({ limit: 30, windowMs: 60_000 });

/** 找回密码的一次性重设令牌：sha256(token) → { userId, email, exp }。只在内存，重启即失效（再收一次验证码） */
const resetTokens = new Map();
const RESET_TTL_MS = 10 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function send(res, r) {
  return res.status(r.status).json(r.body);
}

function emailOr400(req, res, raw) {
  const email = normalizeEmail(raw);
  if (!email) res.status(400).json({ error: msg(req, '邮箱格式不对'), code: 'BAD_EMAIL' });
  return email;
}

/**
 * @param {import('express').Router} router  hostedAuthRouter
 * @param {{ registerQuota: { exhausted: Function, take: Function }, ipLockedMinutes: Function, recordIpFail: Function }} deps
 */
export function mountAuthFlows(router, { registerQuota, ipLockedMinutes, recordIpFail }) {
  const ipLocked = (req, res) => {
    const waitMin = ipLockedMinutes(req);
    if (waitMin) res.status(429).json({ error: msg(req, '尝试次数过多，{waitMin} 分钟后再试', { waitMin }) });
    return waitMin > 0;
  };
  /** 会暴露「邮箱是否注册」的接口共用 identify 的 IP 限频（fable 09-13：否则 identify 限了等于没限） */
  const probeLimited = (req, res) => {
    if (identifyWindow.take(clientIp(req)).ok) return false;
    res.status(429).json({ error: msg(req, '操作太频繁，稍等一会儿再试'), code: 'RATE_LIMITED' });
    return true;
  };
  /** 验证码核验失败：回话术，同时计入 IP 锁（换邮箱轮着猜也要付代价） */
  const codeFailed = (req, res, v) => {
    if (v.code === 'CODE_INVALID') recordIpFail(req);
    return send(res, codeErrorResponse(req, v));
  };

  router.post('/identify', (req, res) => {
    if (!identifyWindow.take(clientIp(req)).ok) return res.status(429).json({ error: msg(req, '操作太频繁，稍等一会儿再试'), code: 'RATE_LIMITED' });
    const raw = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
    if (!raw) return res.status(400).json({ error: msg(req, '请填写邮箱或用户名'), code: 'EMPTY_IDENTIFIER' });
    // 用户名一律进密码框：不存在与密码错误在下一步回同一句话，这一步不暴露
    if (!raw.includes('@')) return res.json({ kind: 'username', next: 'password' });
    const email = emailOr400(req, res, raw);
    if (!email) return;
    const user = getUserByEmail(email);
    if (!user) return res.json({ kind: 'email', exists: false, next: 'register', openRegistration: openRegistrationEnabled() });
    // 停用的号不单独说：跟正常号一样分流，登录那一步照常失败
    res.json({ kind: 'email', exists: true, next: user.hasPassword ? 'password' : 'code', methods: { password: user.hasPassword, emailCode: true } });
  });

  router.post('/register/start', async (req, res) => {
    if (ipLocked(req, res) || probeLimited(req, res)) return;
    const { email: rawEmail, password, inviteCode } = req.body || {};
    const email = emailOr400(req, res, rawEmail);
    if (!email) return;
    if (getUserByEmail(email)) return res.status(409).json({ error: msg(req, '这个邮箱已经注册过了'), code: 'EMAIL_TAKEN' });
    const pw = checkNewPassword(password, { email });
    if (!pw.ok) return send(res, passwordErrorResponse(req, pw.code));
    const invite = typeof inviteCode === 'string' ? inviteCode.trim() : '';
    const pre = precheckSignup(invite);
    if (!pre.ok) {
      if (pre.code === 'BAD_INVITE') recordIpFail(req);   // 乱试邀请码计入 IP 锁
      return res.status(400).json({ error: msg(req, '邀请码无效或已用完'), code: pre.code });
    }
    if (!invite && registerQuota.exhausted(req)) {
      return res.status(429).json({ error: msg(req, '这个网络今天开的号太多了，明天再来'), code: 'REGISTER_RATE_LIMITED' });
    }
    // 密码此刻就哈希好，跟验证码存在一起；明文不落任何地方
    const r = await sendCode(req, { email, purpose: 'signup', payload: { passwordHash: hashPassword(password), inviteCode: invite } });
    if (!r.ok) return send(res, r);
    res.json({ ok: true, email });
  });

  router.post('/register/verify', (req, res) => {
    if (ipLocked(req, res)) return;
    const email = emailOr400(req, res, req.body?.email);
    if (!email) return;
    // 名额先判：别让人把码核验掉了才发现今天开不了号（带邀请码的不占名额，这里只能保守地先按「不带」判，
    // 带码的人撞上时换个网络或明天再来）
    if (registerQuota.exhausted(req)) {
      return res.status(429).json({ error: msg(req, '这个网络今天开的号太多了，明天再来'), code: 'REGISTER_RATE_LIMITED' });
    }
    const v = verifyCode({ email, purpose: 'signup', code: req.body?.code });
    if (!v.ok) return codeFailed(req, res, v);
    const invite = v.payload?.inviteCode || '';
    let user;
    try {
      user = registerWithEmail({ email, passwordHash: v.payload?.passwordHash, inviteCode: invite });
    } catch (err) {
      if (err.code === 'EMAIL_TAKEN') return res.status(409).json({ error: msg(req, '这个邮箱已经注册过了'), code: 'EMAIL_TAKEN' });
      return res.status(400).json({ error: msg(req, '邀请码无效或已用完'), code: err.code || 'REGISTER_FAILED' });
    }
    if (!invite) registerQuota.take(req);
    startSession(res, { userId: user.id, req, method: 'register' });
    recordAuthEvent('register', { userId: user.id, req, detail: { via: 'email', invite: !!invite } });
    res.status(201).json({ ok: true, user: publicUser(user) });
  });

  router.post('/login/code/start', async (req, res) => {
    if (ipLocked(req, res) || probeLimited(req, res)) return;
    const email = emailOr400(req, res, req.body?.email);
    if (!email) return;
    const user = getUserByEmail(email);
    if (!user) return res.status(404).json({ error: msg(req, '这个邮箱还没有注册'), code: 'NO_ACCOUNT' });
    const r = await sendCode(req, { email, purpose: 'login', locale: user.locale });
    if (!r.ok) return send(res, r);
    res.json({ ok: true, email });
  });

  router.post('/login/code/verify', (req, res) => {
    if (ipLocked(req, res)) return;
    const email = emailOr400(req, res, req.body?.email);
    if (!email) return;
    const v = verifyCode({ email, purpose: 'login', code: req.body?.code });
    if (!v.ok) return codeFailed(req, res, v);
    const user = getUserByEmail(email);
    if (!user || user.disabled) return res.status(401).json({ error: msg(req, '账号或密码错误') });
    startSession(res, { userId: user.id, req, method: 'email_code' });
    recordAuthEvent('login_ok', { userId: user.id, req, detail: { via: 'email_code' } });
    res.json({ ok: true, user: publicUser(user) });
  });

  router.post('/password/forgot/start', async (req, res) => {
    if (ipLocked(req, res) || probeLimited(req, res)) return;
    const email = emailOr400(req, res, req.body?.email);
    if (!email) return;
    const user = getUserByEmail(email);
    if (!user) return res.status(404).json({ error: msg(req, '这个邮箱还没有注册'), code: 'NO_ACCOUNT' });
    const r = await sendCode(req, { email, purpose: 'reset', locale: user.locale });
    if (!r.ok) return send(res, r);
    res.json({ ok: true, email });
  });

  router.post('/password/forgot/verify', (req, res) => {
    if (ipLocked(req, res)) return;
    const email = emailOr400(req, res, req.body?.email);
    if (!email) return;
    const v = verifyCode({ email, purpose: 'reset', code: req.body?.code });
    if (!v.ok) return codeFailed(req, res, v);
    const user = getUserByEmail(email);
    if (!user || user.disabled) return res.status(400).json({ error: msg(req, '验证码不对或已过期'), code: 'CODE_INVALID' });
    const now = Date.now();
    for (const [k, t] of resetTokens) if (t.exp <= now) resetTokens.delete(k);
    const token = crypto.randomBytes(32).toString('base64url');
    resetTokens.set(sha256(token), { userId: user.id, email, exp: now + RESET_TTL_MS });
    res.json({ ok: true, resetToken: token });
  });

  router.post('/password/reset', (req, res) => {
    if (ipLocked(req, res)) return;
    const { resetToken, password } = req.body || {};
    const key = sha256(resetToken || '');
    const hit = typeof resetToken === 'string' ? resetTokens.get(key) : null;
    if (!hit || hit.exp <= Date.now()) {
      if (hit) resetTokens.delete(key);
      return res.status(400).json({ error: msg(req, '重设密码的请求已过期，请重新获取验证码'), code: 'RESET_TOKEN_INVALID' });
    }
    const user = getUserByEmail(hit.email);
    if (!user || user.id !== hit.userId || user.disabled) {
      resetTokens.delete(key);
      return res.status(400).json({ error: msg(req, '重设密码的请求已过期，请重新获取验证码'), code: 'RESET_TOKEN_INVALID' });
    }
    const pw = checkNewPassword(password, { email: user.email, username: user.username });
    if (!pw.ok) return send(res, passwordErrorResponse(req, pw.code));   // 令牌不作废：换个密码再提交
    resetTokens.delete(key);
    setPassword(user.id, password);
    // 找回密码意味着可能被人盗过：网页会话、旧 token、桌面设备令牌全部作废，已打开的连接断开
    revokeUserSessions(user.id);
    const devices = revokeUserDevices(user.id);
    noticeMailSafe({ to: user.email, kind: 'password_reset', locale: user.locale });
    startSession(res, { userId: user.id, req, method: 'reset' });
    recordAuthEvent('password_reset', { userId: user.id, req, detail: { devicesRevoked: devices } });
    res.json({ ok: true, user: publicUser(user) });
  });
}

/** 测试用 */
export function _resetFlowState() {
  resetTokens.clear();
}
