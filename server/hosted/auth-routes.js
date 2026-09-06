/**
 * server/hosted/auth-routes.js — 登录墙的**hosted 半**：/api/auth/login 与 /register（只有多用户站才有）。
 *
 * 暴力破解防护：按 IP 记连续失败（登录+注册共用一本账），超限锁 15 分钟。in-memory —— 单实例架构下够用，
 * 重启清零可接受。开放注册后每个 IP 一天最多建几个号（防脚本批量开号吃共享钥匙的限流）。
 *
 * 挂载：hosted/mount.js 的 mountHostedAuth，在 express.json 之后、authGuard 之前，跟内核的 /api/auth 同前缀。
 */

import express from 'express';
import { authEnabled, mintToken, cookieSerialize } from '../auth/session.js';
import { getUserById } from '../auth/users-store.js';
import { publicUser } from '../auth/middleware.js';
import { getCredential, verifyPassword, registerUser } from './users-write.js';
import { makeRateWindow } from '../lib/rate-window.js';
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

/**
 * 账号密码核验 + 按 IP 的爆破锁。网页登录（下面）和桌面版换设备令牌（relay/router.js 的 /login）共用，
 * 两条路一本账 —— 换个入口爆破不该换来一份新的失败额度。
 * @returns {{ ok: true, userId: string } | { ok: false, status: number, message: string }}
 */
export function checkPassword(req, username, password) {
  const ip = clientIp(req);
  const waitMin = locked(ip);
  if (waitMin) return { ok: false, status: 429, message: msg(req, '尝试次数过多，{waitMin} 分钟后再试', { waitMin }) };
  const cred = typeof username === 'string' ? getCredential(username.trim()) : null;
  // cred 不存在也照走 verify（恒定时间语义靠 scrypt 本身的成本；不提前泄漏"用户不存在"）
  const good = cred && !cred.disabled
    && verifyPassword(typeof password === 'string' ? password : '', cred.passwordHash);
  if (!good) {
    recordFail(ip);
    return { ok: false, status: 401, message: msg(req, '用户名或密码错误') };
  }
  failures.delete(ip);
  return { ok: true, userId: cred.id };
}

export const hostedAuthRouter = express.Router();

hostedAuthRouter.post('/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, note: 'auth disabled' });
  const { username, password } = req.body || {};
  const r = checkPassword(req, username, password);
  if (!r.ok) return res.status(r.status).json({ error: r.message });
  res.setHeader('Set-Cookie', cookieSerialize(mintToken(r.userId), req));
  res.json({ ok: true, user: publicUser(getUserById(r.userId)) });
});

hostedAuthRouter.post('/register', (req, res) => {
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

