/**
 * server/hosted/auth-routes.js — 登录墙的**hosted 半**：/api/auth 下的登录、注册（只有多用户站才有）。
 *
 * 09-13 auth-v2 起：
 *   - 登录成功建**服务端会话**（hosted/auth/sessions-store.js），不再签无状态 token
 *   - 登录框收「邮箱或用户名」
 *   - 邮箱注册、验证码登录、找回密码在 hosted/auth/flows-routes.js（同前缀挂在这个路由上）
 *
 * 暴力破解防护两层，都在内存（单实例够用，重启清零可接受）：
 *   - 按 IP：连续失败 10 次锁 15 分钟（登录 + 注册共用一本账）
 *   - 按账号：15 分钟内失败 10 次，暂停这个登录名的密码登录 15 分钟。键是用户输入的登录名本身（不管账号存不存在），
 *     所以它不会变成「这个号存在」的探针；暂停期间回的话跟密码错误一字不差。验证码登录和第三方登录不受影响，
 *     别人没法借此把本人锁在门外。
 * 开放注册后每个 IP 一天最多建几个号（防脚本批量开号吃共享钥匙的限流）。
 *
 * 挂载：hosted/mount.js 的 mountHostedAuth，在 express.json 之后、authGuard 之前，跟内核的 /api/auth 同前缀。
 */

import express from 'express';
import { authEnabled } from '../auth/session.js';
import { getUserById } from '../auth/users-store.js';
import { publicUser } from '../auth/middleware.js';
import { originAllowed } from '../auth/origin-guard.js';
import { getCredential, verifyPassword, registerUser } from './users-write.js';
import { makeRateWindow } from '../lib/rate-window.js';
import { msg } from '../shared/messages.js';
import { clientIp } from './auth/client-ip.js';
import { startSession } from './auth/sessions-store.js';
import { recordAuthEvent } from './auth/audit.js';
import { mountAuthFlows } from './auth/flows-routes.js';
import { mountTurnstileProbe } from './auth/turnstile-probe.js';
import { mountOAuth } from './auth/oauth-routes.js';

const MAX_FAILS = 10;
const DUMMY_HASH = `scrypt$16384$${'0'.repeat(32)}$${'0'.repeat(128)}`;
const LOCK_MS = 15 * 60 * 1000;
/** ip → { fails, lockedUntil } */
const failures = new Map();
/** 登录名（小写）→ 失败时间戳 */
const accountFails = new Map();
// 开放注册后每个 IP 一天最多建几个号（防脚本批量开号吃共享钥匙的限流）。内存窗口，重启清零无所谓
const registerWindow = makeRateWindow({ limit: Number(process.env.NODESIGN_REGISTER_PER_IP_PER_DAY) || 5, windowMs: 24 * 60 * 60 * 1000 });

export { clientIp };

export function ipLockedMinutes(req) {
  const rec = failures.get(clientIp(req));
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
  }
  return 0;
}

export function recordIpFail(req) {
  const ip = clientIp(req);
  const rec = failures.get(ip);
  const next = { fails: (rec?.fails || 0) + 1, lockedUntil: 0 };
  if (next.fails >= MAX_FAILS) {
    next.fails = 0;
    next.lockedUntil = Date.now() + LOCK_MS;
    console.warn(`[auth] ip ${ip} locked for ${LOCK_MS / 60000}min (too many failures)`);
  }
  failures.set(ip, next);
}

function accountPaused(key, now = Date.now()) {
  const arr = (accountFails.get(key) || []).filter((t) => now - t < LOCK_MS);
  if (arr.length) accountFails.set(key, arr); else accountFails.delete(key);
  return arr.length >= MAX_FAILS;
}

let lastSweep = 0;
function sweepAccountFails(now = Date.now()) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, arr] of accountFails) if (!arr.some((t) => now - t < LOCK_MS)) accountFails.delete(k);
}

/**
 * 登录名 + 密码核验，带两层爆破锁。网页登录（下面）和桌面版换设备令牌（relay/router.js 的 /login）共用，
 * 两条路一本账 —— 换个入口爆破不该换来一份新的失败额度。
 * @returns {{ ok: true, userId: string } | { ok: false, status: number, message: string }}
 */
export function checkPassword(req, identifier, password) {
  const waitMin = ipLockedMinutes(req);
  if (waitMin) return { ok: false, status: 429, message: msg(req, '尝试次数过多，{waitMin} 分钟后再试', { waitMin }) };
  sweepAccountFails();
  const key = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
  const cred = key ? getCredential(identifier) : null;
  // 两份计数：用户输入的登录名（不管号存不存在，所以不是存在性探针）+ 真实账号 id（用户名和邮箱轮着试也算同一个号）
  const idKey = cred ? `id:${cred.id}` : null;
  const bad = () => {
    recordIpFail(req);
    const now = Date.now();
    for (const k of [key, idKey]) if (k) accountFails.set(k, [...(accountFails.get(k) || []), now]);
    return { ok: false, status: 401, message: msg(req, '账号或密码错误') };
  };
  // 暂停期间照样回 401 同一句话（不跑 scrypt）。按 id 的那份只对存在的号生效，但它只在同一个号已经被错了
  // 10 次之后才起作用，而那 10 次都是完整走过 scrypt 的，快慢不构成新的探针
  if ((key && accountPaused(key)) || (idKey && accountPaused(idKey))) return bad();
  // cred 不存在也照走 verify（恒定时间语义靠 scrypt 本身的成本；不提前泄漏"用户不存在"）
  // 没这个号、或这个号只用第三方登录（占位哈希 '!'）：拿一个假哈希照样跑一遍 scrypt，耗时跟真核对一样
  const hash = /^scrypt\$/.test(cred?.passwordHash || '') ? cred.passwordHash : DUMMY_HASH;
  const good = verifyPassword(typeof password === 'string' ? password : '', hash) && cred && !cred.disabled && hash !== DUMMY_HASH;
  if (!good) return bad();
  failures.delete(clientIp(req));
  accountFails.delete(key);
  accountFails.delete(idKey);
  return { ok: true, userId: cred.id };
}

export const hostedAuthRouter = express.Router();

// 改状态的接口挡外站：Origin 不在白名单（比如 *.share 子域的发布页）一律 403。
// JSON 请求本来要过 CORS 预检，这一道是给不走预检的简单请求（表单 POST 之类）兜底
hostedAuthRouter.use((req, res, next) => {
  if (req.method !== 'GET' && !originAllowed(req)) return res.status(403).json({ error: 'forbidden origin', code: 'FORBIDDEN_ORIGIN' });
  next();
});

hostedAuthRouter.post('/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, note: 'auth disabled' });
  const { identifier, username, password } = req.body || {};
  const login = typeof identifier === 'string' ? identifier : username;   // username 是 09-13 前的字段名，老前端还在发
  const r = checkPassword(req, login, password);
  if (!r.ok) {
    recordAuthEvent('login_fail', { req, detail: { via: 'password' } });
    return res.status(r.status).json({ error: r.message });
  }
  startSession(res, { userId: r.userId, req, method: 'password' });
  recordAuthEvent('login_ok', { userId: r.userId, req, detail: { via: 'password' } });
  res.json({ ok: true, user: publicUser(getUserById(r.userId)) });
});

// 用户名注册（09-13 前的老路）：新登录页上线后前端不再调，保留到老前端全部下线
hostedAuthRouter.post('/register', (req, res) => {
  const waitMin = ipLockedMinutes(req);
  if (waitMin) return res.status(429).json({ error: msg(req, '尝试次数过多，{waitMin} 分钟后再试', { waitMin }) });

  const ip = clientIp(req);
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
    startSession(res, { userId: user.id, req, method: 'register' });
    recordAuthEvent('register', { userId: user.id, req, detail: { via: 'username' } });
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    // 邀请码乱试也计入锁（防爆破邀请码空间）
    if (err.code === 'BAD_INVITE') recordIpFail(req);
    res.status(400).json({ error: err.message || '注册失败', code: err.code || 'REGISTER_FAILED' });
  }
});

/** 邮箱注册共用同一个每 IP 每日名额 */
export const registerQuota = {
  exhausted: (req) => registerWindow.count(clientIp(req)) >= (Number(process.env.NODESIGN_REGISTER_PER_IP_PER_DAY) || 5),
  take: (req) => registerWindow.take(clientIp(req)),
};

mountAuthFlows(hostedAuthRouter, { registerQuota, ipLockedMinutes, recordIpFail });
mountTurnstileProbe(hostedAuthRouter);
mountOAuth(hostedAuthRouter, { registerQuota });   // Google / GitHub（09-13 第二批），没配 client id 的那家不出现   // Turnstile 测量期（先量后定），没配 site key 时整段不跑

/** 测试用 */
export function _resetAuthThrottles() {
  failures.clear();
  accountFails.clear();
}
