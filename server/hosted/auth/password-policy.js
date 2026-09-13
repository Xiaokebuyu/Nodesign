/**
 * server/hosted/auth/password-policy.js — 新密码的底线（注册、改密码、找回密码共用）
 *
 * 按 NIST SP 800-63B 的思路：只卡长度和「众所周知的弱密码」，不设「必须含大写 + 数字 + 符号」这类组合规则
 * （组合规则逼出来的是 Password1!，不是更强的密码）。
 *
 *   - 8 到 128 位
 *   - 不在常见弱密码表里，去掉结尾的数字 / 符号之后也不在（password123、michael1985 这种）
 *     common-passwords.txt：SecLists 10k-most-common 中 ≥4 位的部分（MIT 许可），外加国内泄露库里常见的几条
 *   - 不是同一个字符重复、不是连续递增 / 递减的数字或字母
 *   - 不等于邮箱 @ 前面那段、不等于用户名
 *
 * 老密码不回溯检查：只在设新密码时判。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMON = new Set(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'common-passwords.txt'), 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean),
);

function isRunOrRepeat(pw) {
  if (/^(.)\1+$/.test(pw)) return true;
  const codes = [...pw].map((c) => c.charCodeAt(0));
  const step = codes[1] - codes[0];
  if (Math.abs(step) !== 1) return false;
  return codes.every((c, i) => i === 0 || c - codes[i - 1] === step);
}

/**
 * @returns {{ ok: true } | { ok: false, code: 'PASSWORD_TOO_SHORT'|'PASSWORD_TOO_LONG'|'PASSWORD_TOO_COMMON' }}
 */
export function checkNewPassword(password, { email = null, username = null } = {}) {
  if (typeof password !== 'string' || password.length < 8) return { ok: false, code: 'PASSWORD_TOO_SHORT' };
  if (password.length > 128) return { ok: false, code: 'PASSWORD_TOO_LONG' };
  const low = password.toLowerCase();
  const local = typeof email === 'string' ? email.split('@')[0].toLowerCase() : null;
  const stem = low.replace(/[\d!@#$%^&*.?_-]+$/, '');
  if (COMMON.has(low) || (stem.length >= 4 && COMMON.has(stem)) || isRunOrRepeat(low)
    || (local && low === local) || (username && low === String(username).toLowerCase())) {
    return { ok: false, code: 'PASSWORD_TOO_COMMON' };
  }
  return { ok: true };
}
