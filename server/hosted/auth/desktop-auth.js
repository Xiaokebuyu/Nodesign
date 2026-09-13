/**
 * server/hosted/auth/desktop-auth.js — 桌面版「在浏览器中登录」的站点侧（09-13 auth-v2 第四批，方案 §5.7）
 *
 * 与 gh、Claude Code 相同的形状（RFC 8252：系统浏览器 + 本机回调 + PKCE）：
 *
 *   1. 桌面本地服务生成 state 与 PKCE verifier，打开系统浏览器到 /desktop-auth?port&state&challenge&device
 *   2. 用户在站点登录（任意方式），确认页展示账号、设备名、本机端口
 *   3. 点「允许」→ POST /api/me/desktop-auth/authorize（JSON，Origin 闸）→ 这里签一次性授权码（60 秒，绑定 challenge）
 *      并回跳转地址。跳转地址由服务端按**数字端口**拼成 http://127.0.0.1:<port>/…，没有任何可控的主机部分
 *   4. 本地服务核对 state，用 code + verifier 调 POST /api/relay/token 换设备令牌（relay/router.js）
 *
 * 授权码只放进程内存、不落表（方案评审定的：60 秒寿命，重启丢了让用户再点一次）。
 *
 * 固有局限（方案 §5.7 已写明）：本机任何进程都能发起流程，用户误点「允许」令牌就给了它；确认页展示设备名与端口作为提示。
 */

import crypto from 'node:crypto';
import express from 'express';
import { originAllowed } from '../../auth/origin-guard.js';
import { getUserById } from '../../auth/users-store.js';
import { msg } from '../../shared/messages.js';
import { listDevices, MAX_DEVICES } from '../relay/devices.js';
import { getSession } from './sessions-store.js';
import { recordAuthEvent } from './audit.js';
import { noticeMailSafe } from './code-mail.js';

export const CODE_TTL_MS = 60 * 1000;
const MAX_CODES = 2000;          // 全站同时活着的授权码上限（60 秒寿命，正常远到不了）
const MAX_CODES_PER_USER = 5;
export const CALLBACK_PATH = '/api/local/relay/callback';

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** sha256(code) → { userId, challenge, label, createdAt, exp } */
const codes = new Map();

function sweep(now = Date.now()) {
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
}

/**
 * 确认页参数校验（前端同一套规则再判一遍，页面上先说「链接无效」）。
 * @returns {{ ok: true, port: number, state: string, challenge: string, device: string } | { ok: false }}
 */
export function parseDesktopAuthParams({ port, state, challenge, device } = {}) {
  const p = typeof port === 'number' ? port : /^\d{1,5}$/.test(String(port ?? '')) ? Number(port) : NaN;
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false };
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return { ok: false };
  // S256 challenge = base64url(sha256(verifier))，恒为 43 个字符
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return { ok: false };
  // 设备名是本机主机名，只作纯文本显示和设备列表标签：去控制字符、截断
  const label = typeof device === 'string' ? device.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, 60) : '';
  return { ok: true, port: p, state, challenge, device: label };
}

/** 签一枚授权码。明文只在返回值里出现一次 */
export function mintDesktopCode({ userId, challenge, label, now = Date.now() }) {
  sweep(now);
  const mine = [...codes.entries()].filter(([, v]) => v.userId === userId).sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (mine.length >= MAX_CODES_PER_USER) codes.delete(mine.shift()[0]);
  if (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(sha256hex(code), { userId, challenge, label: label || null, createdAt: now, exp: now + CODE_TTL_MS });
  return code;
}

/**
 * 用授权码 + verifier 换身份。**查到就删**（不管后面核对成不成）：授权码只能用一次，试错的人也只有一次机会。
 * @returns {{ ok: true, user: object, label: string|null } | { ok: false, code: 'INVALID_CODE' }}
 */
export function redeemDesktopCode({ code, verifier, now = Date.now() }) {
  const bad = { ok: false, code: 'INVALID_CODE' };
  if (typeof code !== 'string' || code.length > 200 || typeof verifier !== 'string') return bad;
  // RFC 7636：verifier 43~128 个 unreserved 字符
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return bad;
  const key = sha256hex(code);
  const hit = codes.get(key);
  codes.delete(key);
  if (!hit || hit.exp <= now) return bad;
  const want = Buffer.from(hit.challenge, 'utf8');
  const got = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'), 'utf8');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return bad;
  const user = getUserById(hit.userId);
  if (!user || user.disabled) return bad;
  // 签码之后账号「全部下线」过（找回密码 / 停用再启用）：这枚码跟着作废
  if (user.sessionsValidAfter && Date.parse(user.sessionsValidAfter) > hit.createdAt) return bad;
  return { ok: true, user, label: hit.label };
}

/** 新设备入账之后的收尾：审计 + 安全通知（设备令牌长期有效，通知是用户得知新设备的唯一途径） */
export function noteNewDevice(req, user, device, via) {
  recordAuthEvent('device_added', { userId: user.id, req, detail: { via, deviceId: device.id } });
  if (user.email) noticeMailSafe({ to: user.email, kind: 'device_added', locale: user.locale });
}

/** /api/me/desktop-auth（authGuard 之后）：确认页的「允许」 */
export function createDesktopAuthRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.method !== 'GET' && !originAllowed(req)) return res.status(403).json({ error: 'forbidden origin', code: 'FORBIDDEN_ORIGIN' });
    next();
  });

  router.post('/authorize', (req, res) => {
    // 只认服务端会话：无头感知浏览器的内部凭证、刚换发的旧 token 都不能替用户签设备令牌
    const session = req.auth?.kind === 'session' && req.auth.sessionId ? getSession(req.auth.sessionId) : null;
    if (!session) return res.status(409).json({ error: msg(req, '登录状态刚刚更新，请刷新页面后再试'), code: 'SESSION_REFRESH_REQUIRED' });
    const p = parseDesktopAuthParams(req.body || {});
    if (!p.ok) return res.status(400).json({ error: msg(req, '登录链接无效，请回到 NoDesign 桌面版重新发起'), code: 'BAD_REQUEST' });
    const user = getUserById(req.user.id);
    if (listDevices(user.id).filter((d) => !d.revoked).length >= MAX_DEVICES) {
      return res.status(409).json({ error: msg(req, '在用设备数量已达上限（{n} 台），请先在设置中退出一台设备', { n: MAX_DEVICES }), code: 'TOO_MANY_DEVICES' });
    }
    const code = mintDesktopCode({ userId: user.id, challenge: p.challenge, label: p.device });
    recordAuthEvent('desktop_authorize', { userId: user.id, req, detail: { port: p.port } });
    const q = new URLSearchParams({ code, state: p.state });
    res.json({ ok: true, redirect: `http://127.0.0.1:${p.port}${CALLBACK_PATH}?${q}` });
  });

  return router;
}

/** 测试用 */
export function _resetDesktopCodes() { codes.clear(); }
