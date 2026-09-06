/**
 * server/auth/middleware.js — 登录墙的**内核半**：/api/auth 里两边都要的路由 + /api 守卫
 *
 * - GET  /api/auth/status   → {required, authed, user, profile}（前端 AuthGate 用，永远放行；本地版靠它知道没有登录墙）
 * - PUT  /api/auth/locale   → 记住界面语言（登录用户写账号；本地版 LOCAL_OWNER 不在表里，写了也是 noop）
 * - POST /api/auth/logout   → 清 cookie
 * - authGuard：其余 /api/* 无有效身份一律 401；有则挂 req.user（本地版由 session.requestUser 给 LOCAL_OWNER）
 *
 * 登录 / 注册（带暴力破解防护、开放注册的 IP 限流）只有多用户站才有，在 server/hosted/auth-routes.js，
 * 由 hosted/mount.js 挂到同一个 /api/auth 前缀下。09-06 拆：之前一份文件两边都装，本地分发版跟着带走了
 * 整套登录注册。
 */

import express from 'express';
import { authEnabled, requestUser, cookieClear } from './session.js';
import { openRegistrationEnabled, updateUser } from './users-store.js';
import { LOCALES, isLocale } from '../shared/locales.js';
import { platform } from '../runtime/platform.js';
import { msg } from '../shared/messages.js';

// locale：界面语言偏好，null = 没表过态（前端这时落浏览器语言，见 lib/i18n.js detect）
export const publicUser = (u) => (u ? { id: u.id, username: u.username, role: u.role, locale: u.locale ?? null } : null);

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
