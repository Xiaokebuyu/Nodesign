/**
 * server/hosted/auth/mail-suppression.js — 退信 / 投诉的记账与本地抑制名单
 *
 * SES 2026-09-16 出沙盒后，配置集把 Bounce / Complaint / Reject / DeliveryDelay 四类事件
 * 发到 SNS，ses-events.js 收下来写这两张表：
 *
 *   email_feedback     事件流水，一个收件人一行（一次退信可能涉及多个收件人）
 *   email_suppression  本地抑制名单，在名单上的地址一律不再发信
 *
 * ## 为什么本地还要存一份抑制名单
 *
 * AWS 账号级抑制列表本来就会拦住后续发信，但它拦的方式是 SendEmail 照常成功返回、
 * 信静默不发。用户那边的表现是「页面说已发送，邮箱里永远没有」。本地有名单，才能在
 * 签验证码之前就拒掉，并且告诉用户这个邮箱收不了信、换一个。
 *
 * ## 什么进名单
 *
 *   Permanent 退信          进。地址不存在或被永久拒收，SES 文档要求把这类地址从发送名单里去掉
 *   Complaint               进。被标记为垃圾邮件，继续发只会继续损害发信信誉
 *   Transient 退信          不进，只记账。邮箱满、对方服务器临时故障这类以后可能发得进去
 *   Reject / DeliveryDelay  不进，只记账。前者是我们的内容被判有病毒，跟收件人地址无关
 *
 * 解除只有手动（unsuppressEmail）。用户换个邮箱就能继续用，不做自助解除：
 * 地址退信的原因在对方服务器上，我们这边点一下并不会让它变得能收信。
 */

import db from '../../engine/runs/store.js';
import { normalizeEmail } from '../../auth/users-store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS email_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sns_message_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    subtype TEXT,
    detail TEXT,
    ses_message_id TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_feedback_email ON email_feedback(email, at);
  -- email 用空串不用 NULL：SQLite 的唯一索引不把两个 NULL 当成重复，无收件人的事件重投会一次多一行
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_feedback_sns ON email_feedback(sns_message_id, email);
  CREATE TABLE IF NOT EXISTS email_suppression (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  );
`);

/** diagnosticCode 这类字段可以很长，存个够排查的长度就行 */
const trim = (s, n = 300) => (typeof s === 'string' && s ? s.slice(0, n) : null);

/**
 * 记一条事件。SNS 是至少一次投递，同一条消息可能来两遍，靠 (sns_message_id, email) 唯一索引去重。
 * @returns {{ recorded: boolean }} recorded=false 表示这条之前已经记过
 */
export function recordFeedback({ snsMessageId, eventType, email = null, subtype = null, detail = null, sesMessageId = null, at = Date.now() }) {
  const r = db.prepare(`
    INSERT OR IGNORE INTO email_feedback (sns_message_id, event_type, email, subtype, detail, ses_message_id, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(String(snsMessageId), String(eventType), email || '', trim(subtype, 64), trim(detail), trim(sesMessageId, 128), at);
  return { recorded: r.changes > 0 };
}

/**
 * 把地址加进抑制名单。已经在名单上的保留最早那条原因（第一次为什么被拦更有排查价值）。
 * @returns {boolean} 这次是不是新加的
 */
export function suppressEmail(email, reason, detail = null, at = Date.now()) {
  const e = normalizeEmail(email);
  if (!e) return false;
  const r = db.prepare('INSERT OR IGNORE INTO email_suppression (email, reason, detail, at) VALUES (?, ?, ?, ?)')
    .run(e, String(reason), trim(detail), at);
  return r.changes > 0;
}

/** 手动解除（管理台 / 站主）。@returns {boolean} 之前是否在名单上 */
export function unsuppressEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  return db.prepare('DELETE FROM email_suppression WHERE email = ?').run(e).changes > 0;
}

/** 在名单上就返回那一行，不在返回 null。调用方要拿 reason 决定话术 */
export function suppressionFor(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return db.prepare('SELECT email, reason, detail, at FROM email_suppression WHERE email = ?').get(e) || null;
}

export function isSuppressed(email) {
  return suppressionFor(email) != null;
}

/** 管理台用：最近的事件流水 */
export function listFeedback({ email = null, limit = 100 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 100), 500);
  if (email) {
    const e = normalizeEmail(email);
    if (!e) return [];
    return db.prepare('SELECT * FROM email_feedback WHERE email = ? ORDER BY at DESC LIMIT ?').all(e, n);
  }
  return db.prepare('SELECT * FROM email_feedback ORDER BY at DESC LIMIT ?').all(n);
}

/** 管理台用：当前抑制名单 */
export function listSuppressed({ limit = 200 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 200), 1000);
  return db.prepare('SELECT email, reason, detail, at FROM email_suppression ORDER BY at DESC LIMIT ?').all(n);
}

/**
 * 事件流水的保存期限（retention.js 调）。
 * ⛔ 抑制名单本身不清理：删掉就会重新往已知的死地址发信，这正是这张表要防的事。
 */
export function pruneFeedback(before) {
  return db.prepare('DELETE FROM email_feedback WHERE at < ?').run(before).changes;
}
