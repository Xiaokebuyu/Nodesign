/**
 * server/auth/internal-credentials.js — 进程内签发的短期凭证（感知工具的无头浏览器用）
 *
 * look_at_board / 感知工具要用项目所有者的身份打开画布页。它们走 http://127.0.0.1，
 * 拿不到要求 Secure 的 `__Host-` 会话 cookie，也不该为一次截图建一条用户看得见的会话。
 * 所以单开一种凭证：随机 32 字节，只存在本进程内存里，1 小时过期，重启即失效。
 *
 * 它不在库里，所以别的进程（exp 实例、脚本）签不出能被本进程认的凭证；账号「全部下线」时
 * 由 hosted 调 revokeInternalTokensFor 一并清掉。
 */

import crypto from 'node:crypto';

export const INTERNAL_COOKIE = 'nd_internal';
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

/** token → { userId, exp } */
const tokens = new Map();

function sweep(now) {
  for (const [k, v] of tokens) if (v.exp <= now) tokens.delete(k);
}

/** @returns {{ name: string, value: string }} 直接喂给 playwright context.addCookies */
export function mintInternalCookie(userId, now = Date.now()) {
  if (!userId) throw new Error('mintInternalCookie: userId 必填');
  sweep(now);
  if (tokens.size >= MAX_ENTRIES) tokens.delete(tokens.keys().next().value);
  const value = crypto.randomBytes(32).toString('base64url');
  tokens.set(value, { userId, exp: now + TTL_MS });
  return { name: INTERNAL_COOKIE, value };
}

/** @returns {{ userId: string } | null} */
export function verifyInternalToken(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length !== 43) return null;
  const hit = tokens.get(value);
  if (!hit) return null;
  if (hit.exp <= now) { tokens.delete(value); return null; }
  return { userId: hit.userId };
}

export function revokeInternalTokensFor(userId) {
  for (const [k, v] of tokens) if (v.userId === userId) tokens.delete(k);
}
