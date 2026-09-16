/**
 * server/hosted/auth/code-mail.js — 「签一枚验证码并发出去」与各类失败的用户话术（flows / account 两处共用）
 *
 * 话术集中在这里：msg() 的 key 必须是字面量才进得了英文词表对账（shared/messages.lint.test.js），
 * 所以用 switch 逐条写，不做映射表。
 */

import { issueCode, discardCode, supersedeOlderCodes } from './email-codes.js';
import { suppressionFor } from './mail-suppression.js';
import { sendMail } from './mailer.js';
import { codeMail, noticeMail } from './mail-templates.js';
import { clientIp } from './client-ip.js';
import { localeOf, msg } from '../../shared/messages.js';

const minutes = (ms) => Math.max(1, Math.ceil((ms || 0) / 60000));
const seconds = (ms) => Math.max(1, Math.ceil((ms || 0) / 1000));

/** 验证码签发 / 核验失败 → { status, body } */
export function codeErrorResponse(req, r) {
  switch (r.code) {
    case 'RESEND_TOO_SOON':
      return { status: 429, body: { error: msg(req, '发送太频繁，{sec} 秒后再试', { sec: seconds(r.retryAfterMs) }), code: r.code, retryAfterMs: r.retryAfterMs } };
    case 'EMAIL_RATE_LIMITED':
      return { status: 429, body: { error: msg(req, '这个邮箱收到的验证码太多了，{min} 分钟后再试', { min: minutes(r.retryAfterMs) }), code: r.code, retryAfterMs: r.retryAfterMs } };
    case 'IP_RATE_LIMITED':
      return { status: 429, body: { error: msg(req, '这个网络发送的验证码太多了，{min} 分钟后再试', { min: minutes(r.retryAfterMs) }), code: r.code, retryAfterMs: r.retryAfterMs } };
    case 'CODE_LOCKED':
      return { status: 429, body: { error: msg(req, '验证码错误次数太多，{min} 分钟后再试', { min: minutes(r.retryAfterMs) }), code: r.code, retryAfterMs: r.retryAfterMs } };
    case 'CODE_INVALID':
      return { status: 400, body: { error: msg(req, '验证码不对或已过期'), code: r.code } };
    case 'EMAIL_SUPPRESSED':
      // 退信 / 投诉过的地址（mail-suppression.js）。AWS 账号级抑制也会拦，但那边拦的表现是
      // 发信成功返回、信不送达，用户只会看到"已发送"然后永远收不到，所以在这里就说清楚
      return { status: 400, body: { error: r.reason === 'complaint'
        ? msg(req, '这个邮箱把我们的邮件标记过垃圾邮件，收不到验证码了，请换一个邮箱')
        : msg(req, '这个邮箱退信了，收不到验证码，请换一个邮箱'), code: r.code } };
    case 'MAIL_SEND_FAILED':
      return { status: 502, body: { error: msg(req, '验证码邮件没有发出去，请稍后再试'), code: r.code } };
    default:
      return { status: 400, body: { error: msg(req, '验证码不对或已过期'), code: r.code || 'CODE_INVALID' } };
  }
}

/** 新密码不合格 → { status, body } */
export function passwordErrorResponse(req, code) {
  switch (code) {
    case 'PASSWORD_TOO_LONG':
      return { status: 400, body: { error: msg(req, '密码最长 128 位'), code } };
    case 'PASSWORD_TOO_COMMON':
      return { status: 400, body: { error: msg(req, '这个密码太常见了，换一个'), code } };
    default:
      return { status: 400, body: { error: msg(req, '密码至少 8 位'), code: 'PASSWORD_TOO_SHORT' } };
  }
}

/**
 * 签码 + 发信。发信失败撤回这枚码（不占用户的重发名额）。
 * @returns {Promise<{ ok: true } | { ok: false, status: number, body: object }>}
 */
export async function sendCode(req, { email, purpose, payload = null, locale = null }) {
  const blocked = suppressionFor(email);
  if (blocked) return { ok: false, ...codeErrorResponse(req, { code: 'EMAIL_SUPPRESSED', reason: blocked.reason }) };
  const issued = issueCode({ email, purpose, payload, ip: clientIp(req) });
  if (!issued.ok) return { ok: false, ...codeErrorResponse(req, issued) };
  const mail = codeMail({ code: issued.code, purpose, locale: locale || localeOf(req) });
  try {
    await sendMail({ to: email, ...mail });
  } catch {
    discardCode(issued.id);
    return { ok: false, ...codeErrorResponse(req, { code: 'MAIL_SEND_FAILED' }) };
  }
  supersedeOlderCodes(issued.id);
  return { ok: true };
}

/**
 * 安全通知：发不出去只记日志，不挡住已经做完的操作（密码已经改了，不能因为通知没发出去回滚）。
 * 不 await：调用方不等 SES 往返。
 */
export function noticeMailSafe({ to, kind, locale }) {
  if (!to) return;
  // 已知收不到信的地址不再发：白发一封，还给发信信誉再记一次退信
  if (suppressionFor(to)) return;
  sendMail({ to, ...noticeMail({ kind, locale }) }).catch((err) => {
    console.warn(`[mail] 安全通知 ${kind} 没发出去：${err.message}`);
  });
}
