/**
 * server/auth/middleware.js — 登录墙（v2 多用户）：/api/auth 路由 + /api 守卫
 *
 * - POST /api/auth/login    {username, password} → Set-Cookie nd_auth（v2 token 带身份）
 * - POST /api/auth/register {username, password, inviteCode} → 建号并直接登录
 * - POST /api/auth/logout   → 清 cookie
 * - GET  /api/auth/status   → {required, authed, user}（前端 AuthGate 用，永远放行）
 * - authGuard：其余 /api/* 无有效身份一律 401；有则挂 req.user
 *
 * 暴力破解防护：按 IP 记连续失败（登录+注册共用一本账），超限锁 15 分钟。
 * in-memory —— 单实例架构下够用，重启清零可接受。
 */

import express from 'express';
import {
  authEnabled, mintToken, requestUser, cookieSerialize, cookieClear,
} from './session.js';
import { getCredential, verifyPassword, getUserById, registerUser, openRegistrationEnabled, updateUser } from './users-store.js';
import { LOCALES, isLocale } from '../shared/locales.js';
import { makeRateWindow } from '../lib/rate-window.js';
import { platform } from '../runtime/platform.js';
import { msg } from '../shared/messages.js';

const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;
/** ip → { fails, lockedUntil } */
const failures = new Map();
// 开放注册后每个 IP 一天最多建几个号（防脚本批量开号吃共享钥匙的限流）。内存窗口，重启清零无所谓
const registerWindow = makeRateWindow({ limit: Number(process.env.NODESIGN_REGISTER_PER_IP_PER_DAY) || 5, windowMs: 24 * 60 * 60 * 1000 });

function clientIp(req) {
  // ⛔ 不看 X-Forwarded-For：它的第一跳是客户端自报的（CF/nginx 都是追加不是覆盖），
  // 随机填一个就绕过注册限流和登录锁（08-21 fable 评审）。可信顺序：CF 的 cf-connecting-ip
  // → nginx 写的 X-Real-IP（$remote_addr，是对端不是自报）→ socket
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req.socket?.remoteAddress || 'unknown';
}

function locked(ip) {
  const rec = failures.get(ip);
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
  }
  return 0;
}

function recordFail(ip) {
  const rec = failures.get(ip);
  const next = { fails: (rec?.fails || 0) + 1, lockedUntil: 0 };
  if (next.fails >= MAX_FAILS) {
    next.fails = 0;
    next.lockedUntil = Date.now() + LOCK_MS;
    console.warn(`[auth] ip ${ip} locked for ${LOCK_MS / 60000}min (too many failures)`);
  }
  failures.set(ip, next);
}

// locale：界面语言偏好，null = 没表过态（前端这时落浏览器语言，见 lib/i18n.js detect）
const publicUser = (u) => (u ? { id: u.id, username: u.username, role: u.role, locale: u.locale ?? null } : null);

export const authRouter = express.Router();

authRouter.get('/status', (req, res) => {
  const user = requestUser(req);
  // profile：前端据此藏 SaaS 那套界面（账号徽记 / 额度横幅 / 管理入口）。local = 本地单租户分发版
  res.json({ required: authEnabled(), authed: !!user, user: publicUser(user), openRegistration: openRegistrationEnabled(), profile: platform.profile });
});

/**
 * 记住界面语言（2026-08-26 i18n）。
 *
 * 只有登录用户才写账号；没登录的人切语言只落 localStorage（前端自己管），
 * 这里 401 让前端知道"没存上"，但前端**不该因此把切换器禁掉** —— 登录墙外面
 * 也要能换语言，不然英文用户连注册按钮都读不懂。
 *
 * body: { locale: 'zh-CN' | 'en' | null }。null = 清掉偏好，回到跟浏览器走。
 */
authRouter.put('/locale', (req, res) => {
  const user = requestUser(req);
  if (!user) return res.status(401).json({ error: msg(req, '没登录，语言只记在这台机器上') });
  const { locale } = req.body || {};
  if (locale !== null && !isLocale(locale)) {
    return res.status(400).json({ error: msg(req, 'locale 需为 {allowed} 或 null', { allowed: LOCALES.join(' / ') }) });
  }
  updateUser(user.id, { locale });
  res.json({ ok: true, locale: locale ?? null });
});

authRouter.post('/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, note: 'auth disabled' });

  const ip = clientIp(req);
  const waitMin = locked(ip);
  if (waitMin) return res.status(429).json({ error: msg(req, '尝试次数过多，{waitMin} 分钟后再试', { waitMin }) });

  const { username, password } = req.body || {};
  const cred = typeof username === 'string' ? getCredential(username.trim()) : null;
  // cred 不存在也照走 verify（恒定时间语义靠 scrypt 本身的成本；不提前泄漏"用户不存在"）
  const ok = cred && !cred.disabled
    && verifyPassword(typeof password === 'string' ? password : '', cred.passwordHash);
  if (!ok) {
    recordFail(ip);
    return res.status(401).json({ error: msg(req, '用户名或密码错误') });
  }

  failures.delete(ip);
  res.setHeader('Set-Cookie', cookieSerialize(mintToken(cred.id), req));
  res.json({ ok: true, user: publicUser(getUserById(cred.id)) });
});

authRouter.post('/register', (req, res) => {
  const ip = clientIp(req);
  const waitMin = locked(ip);
  if (waitMin) return res.status(429).json({ error: msg(req, '尝试次数过多，{waitMin} 分钟后再试', { waitMin }) });

  const { username, password, inviteCode } = req.body || {};
  const hasInvite = typeof inviteCode === 'string' && inviteCode.trim();
  const perIpLimit = Number(process.env.NODESIGN_REGISTER_PER_IP_PER_DAY) || 5;
  if (!hasInvite && registerWindow.count(ip) >= perIpLimit) {
    return res.status(429).json({ error: msg(req, '这个网络今天开的号太多了，明天再来'), code: 'REGISTER_RATE_LIMITED' });
  }
  try {
    const user = registerUser({
      username: typeof username === 'string' ? username.trim() : '',
      password,
      inviteCode: typeof inviteCode === 'string' ? inviteCode.trim() : '',
    });
    failures.delete(ip);
    if (!hasInvite) registerWindow.take(ip);   // 做成了才扣名额（用户名撞车不算）
    res.setHeader('Set-Cookie', cookieSerialize(mintToken(user.id), req));
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    // 邀请码乱试也计入锁（防爆破邀请码空间）
    if (err.code === 'BAD_INVITE') recordFail(ip);
    res.status(400).json({ error: err.message || '注册失败', code: err.code || 'REGISTER_FAILED' });
  }
});

authRouter.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', cookieClear());
  res.json({ ok: true });
});

/** 挂在业务路由之前的守卫：验身份 + 挂 req.user */
export function authGuard(req, res, next) {
  const user = requestUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  res.status(401).json({ error: 'unauthorized', code: 'AUTH_REQUIRED' });
}

/** admin 专属路由守卫（挂在 authGuard 之后） */
export function adminGuard(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'admin only', code: 'FORBIDDEN' });
}
