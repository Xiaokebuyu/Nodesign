/**
 * server/hosted/auth/email-codes.js — 6 位邮箱验证码：签发、限频、核验
 *
 * ## 限频为什么落库、为什么按邮箱算
 *
 * 验证码能被猜：6 位 = 百万分之一。防线是「猜的次数」，所以错误次数必须按**邮箱**累计、且**不分用途**
 * —— 按码算的话攻击者每拿一枚新码就重置计数；分用途的话登录猜满了换找回密码接着猜（fable 09-13 评审）。
 * 这些计数要扛得住重启（pm2 一重启就清零 = 白送一轮），所以落库，不用内存窗口。
 *
 *   发码：同一邮箱同一用途 60 秒 1 封；同一邮箱 1 小时 5 封；同一 IP 1 小时 20 封；新码发出后作废同邮箱同用途的旧码
 *   核验：错误按邮箱累计（只在确有待核验的码时计），1 小时 25 次、滚动 24 小时 30 次，超了该邮箱所有验证码核验暂停
 *
 * 按这组数，针对一个邮箱每天最多猜 30 次，持续 30 天累计命中约 0.1%，期间受害者会一直收到验证码邮件。
 *
 * 码不存明文：HMAC(服务端密钥, email|purpose|code)。库泄漏时百万分之一的空间几秒就能穷举，
 * 带密钥的哈希才挡得住。
 */

import crypto from 'node:crypto';
import db from '../../engine/runs/store.js';
import { authSecret } from '../../auth/session.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    payload TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at);
  CREATE INDEX IF NOT EXISTS idx_email_codes_ip ON email_codes(ip, created_at);
  CREATE TABLE IF NOT EXISTS email_code_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_code_failures_email ON email_code_failures(email, at);
`);

export const PURPOSES = ['signup', 'login', 'reset', 'verify_email', 'reauth', 'link'];

const MIN = 60_000;
const HOUR = 60 * MIN;
export const LIMITS = {
  codeTtlMs: 10 * MIN,
  resendMs: MIN,
  perEmailHour: 5,
  perIpHour: 20,
  failPerHour: 25,
  failPerDay: 30,
  lockMs: 24 * HOUR,
};

const hashCode = (email, purpose, code) =>
  crypto.createHmac('sha256', authSecret()).update(`${email}|${purpose}|${code}`).digest('hex');

function fail(code, extra = {}) {
  return { ok: false, code, ...extra };
}

/** 该邮箱现在是否处于核验暂停期；是的话返回剩余毫秒 */
export function verifyLockedFor(email, now = Date.now()) {
  const dayFails = db.prepare('SELECT at FROM email_code_failures WHERE email = ? AND at > ? ORDER BY at ASC').all(email, now - LIMITS.lockMs);
  if (dayFails.length >= LIMITS.failPerDay) {
    // 第 30 次失败起算 24 小时
    const trigger = dayFails[dayFails.length - LIMITS.failPerDay].at;
    return Math.max(0, trigger + LIMITS.lockMs - now) || 0;
  }
  const hourFails = dayFails.filter((r) => r.at > now - HOUR);
  if (hourFails.length >= LIMITS.failPerHour) return hourFails[0].at + HOUR - now;
  return 0;
}

/**
 * 签发一枚码。调用方拿到 code 负责发信，**不要落日志**。
 * @returns {{ ok: true, code: string, id: number } | { ok: false, code: 'RESEND_TOO_SOON'|'EMAIL_RATE_LIMITED'|'IP_RATE_LIMITED', retryAfterMs: number }}
 */
export function issueCode({ email, purpose, payload = null, ip = null, now = Date.now() }) {
  if (!PURPOSES.includes(purpose)) throw new Error(`issueCode: 未知用途 ${purpose}`);
  const recent = db.prepare('SELECT created_at, purpose FROM email_codes WHERE email = ? AND created_at > ? ORDER BY created_at DESC').all(email, now - HOUR);
  // 60 秒冷却按「邮箱 + 用途」：刚注册完马上要登录码不该被拦；1 小时 5 封按邮箱整体算
  const samePurpose = recent.find((r) => r.purpose === purpose);
  if (samePurpose && now - samePurpose.created_at < LIMITS.resendMs) {
    return fail('RESEND_TOO_SOON', { retryAfterMs: LIMITS.resendMs - (now - samePurpose.created_at) });
  }
  if (recent.length >= LIMITS.perEmailHour) {
    return fail('EMAIL_RATE_LIMITED', { retryAfterMs: recent[recent.length - 1].created_at + HOUR - now });
  }
  if (ip) {
    const byIp = db.prepare('SELECT created_at FROM email_codes WHERE ip = ? AND created_at > ? ORDER BY created_at ASC').all(ip, now - HOUR);
    if (byIp.length >= LIMITS.perIpHour) return fail('IP_RATE_LIMITED', { retryAfterMs: byIp[0].created_at + HOUR - now });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const r = db.prepare('INSERT INTO email_codes (email, purpose, code_hash, payload, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(email, purpose, hashCode(email, purpose, code), payload == null ? null : JSON.stringify(payload), ip, now, now + LIMITS.codeTtlMs);
  return { ok: true, code, id: Number(r.lastInsertRowid) };
}

/** 发信失败时撤回刚签的码（不占用户的重发名额；手里那枚旧码还能用） */
export function discardCode(id) {
  db.prepare('DELETE FROM email_codes WHERE id = ?').run(id);
}

/**
 * 信发出去之后调：作废同邮箱同用途更早的码，只留这一枚。放在发信之后而不是签发时，
 * 发信失败撤回新码时用户手里的旧码不受影响（fable 09-13）。
 */
export function supersedeOlderCodes(id, now = Date.now()) {
  const row = db.prepare('SELECT email, purpose FROM email_codes WHERE id = ?').get(id);
  if (!row) return;
  db.prepare('UPDATE email_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND id != ?').run(now, row.email, row.purpose, id);
}

/**
 * 核验。成功即消耗。
 * @returns {{ ok: true, payload: any } | { ok: false, code: 'CODE_LOCKED'|'CODE_INVALID', retryAfterMs?: number }}
 */
export function verifyCode({ email, purpose, code, now = Date.now() }) {
  const locked = verifyLockedFor(email, now);
  if (locked > 0) return fail('CODE_LOCKED', { retryAfterMs: locked });
  const row = db.prepare(`SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
                          ORDER BY created_at DESC LIMIT 1`).get(email, purpose, now);
  const clean = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  const good = row && /^\d{6}$/.test(clean)
    && crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(email, purpose, clean), 'hex'));
  if (!good) {
    // 只在这个邮箱这个用途确实有一枚待核验的码时才记失败：不然任何人对任意邮箱乱打 30 次错码，
    // 就能把人家的验证码核验锁一天（fable 09-13）。攻击者要先触发发码，而发码有限频、受害者会收到邮件
    if (row) db.prepare('INSERT INTO email_code_failures (email, at) VALUES (?, ?)').run(email, now);
    return fail('CODE_INVALID');
  }
  db.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').run(now, row.id);
  return { ok: true, payload: row.payload ? JSON.parse(row.payload) : null };
}
