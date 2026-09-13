/**
 * server/hosted/auth/mail-templates.js — 验证码与安全通知邮件的正文
 *
 * 口径（09-13 调研，原文在 ~/claude-report-file/0913-auth/research*）：
 *   - 纯文本正文，外面套一层共用的简单 HTML 版式；两者内容一致
 *   - 不放链接（腾讯云邮件推送的反垃圾建议：URL 容易被判垃圾邮件）
 *   - 用户自己填的内容（用户名等）不进正文（QQ 邮箱会检查自定义字段是否夹带垃圾内容）
 *   - 中英两版，按账号语言或请求的 Accept-Language
 */

const SITE = 'nodesign.xiaobuyu.trade';

const PURPOSE_TEXT = {
  'zh-CN': {
    signup: '注册 NoDesign 账号',
    login: '登录 NoDesign',
    reset: '重设 NoDesign 密码',
    verify_email: '绑定这个邮箱到你的 NoDesign 账号',
    reauth: '确认是你本人在修改账号设置',
    link: '把第三方登录关联到你的 NoDesign 账号',
  },
  en: {
    signup: 'create your NoDesign account',
    login: 'sign in to NoDesign',
    reset: 'reset your NoDesign password',
    verify_email: 'add this email address to your NoDesign account',
    reauth: 'confirm it is you changing your account settings',
    link: 'link a sign-in method to your NoDesign account',
  },
};

const lang = (locale) => (locale === 'en' ? 'en' : 'zh-CN');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 文本 → 共用 HTML 版式（段落按空行切；code 单独放大显示） */
function wrapHtml(paragraphs, { code = null } = {}) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.6">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const codeBlock = code
    ? `<p style="margin:0 0 18px;font-size:30px;letter-spacing:6px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f4ef;color:#1f1d1a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px">`
    + `<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #1f1d1a;padding:28px">`
    + `<p style="margin:0 0 18px;font-weight:600;letter-spacing:1px">NoDesign</p>${codeBlock}${body}`
    + `<p style="margin:18px 0 0;color:#77716a;font-size:12px">${SITE}</p></div></body></html>`;
}

/** @returns {{ subject: string, text: string, html: string }} */
export function codeMail({ code, purpose, locale }) {
  const l = lang(locale);
  const what = PURPOSE_TEXT[l][purpose] || PURPOSE_TEXT[l].login;
  if (l === 'en') {
    const paras = [`Use this code to ${what}. It expires in 10 minutes.`, 'If you did not request it, you can ignore this email.'];
    return { subject: `${code} is your NoDesign code`, text: [`Your code: ${code}`, ...paras, SITE].join('\n\n'), html: wrapHtml(paras, { code }) };
  }
  const paras = [`这个验证码用于${what}，10 分钟内有效。`, '如果不是你本人的操作，忽略这封邮件即可。'];
  return { subject: `${code} 是你的 NoDesign 验证码`, text: [`你的验证码：${code}`, ...paras, SITE].join('\n\n'), html: wrapHtml(paras, { code }) };
}

const NOTICE_TEXT = {
  password_changed: {
    'zh-CN': ['你的 NoDesign 账号密码刚刚被修改', '你的 NoDesign 账号密码刚刚被修改，其他设备上的网页登录已经退出。'],
    en: ['Your NoDesign password was changed', 'The password for your NoDesign account was just changed. Web sessions on other devices have been signed out.'],
  },
  password_reset: {
    'zh-CN': ['你的 NoDesign 账号密码已通过邮箱重设', '你的 NoDesign 账号密码刚刚通过邮箱验证码重设，所有设备（包括桌面版）都已退出登录。'],
    en: ['Your NoDesign password was reset', 'The password for your NoDesign account was just reset by email code. All devices, including the desktop app, have been signed out.'],
  },
  email_changed: {
    'zh-CN': ['你的 NoDesign 账号邮箱已更换', '你的 NoDesign 账号绑定的邮箱刚刚从这个地址换成了另一个地址。之后的验证码和通知会发到新地址。'],
    en: ['Your NoDesign email address was changed', 'The email address on your NoDesign account was just changed from this address to another one. Codes and notices will go to the new address.'],
  },
  identity_linked: {
    'zh-CN': ['你的 NoDesign 账号关联了新的登录方式', '你的 NoDesign 账号刚刚关联了一个第三方登录方式（Google 或 GitHub），之后可以用它直接登录。'],
    en: ['A sign-in method was linked to your NoDesign account', 'A third-party sign-in method (Google or GitHub) was just linked to your NoDesign account and can now be used to sign in.'],
  },
  email_added: {
    'zh-CN': ['邮箱已绑定到你的 NoDesign 账号', '这个邮箱刚刚绑定到你的 NoDesign 账号，之后可以用它登录和找回密码。'],
    en: ['Email added to your NoDesign account', 'This email address was just added to your NoDesign account. You can now use it to sign in and recover your password.'],
  },
};

/**
 * @param {{ kind: keyof typeof NOTICE_TEXT, locale?: string }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function noticeMail({ kind, locale }) {
  const l = lang(locale);
  const t = NOTICE_TEXT[kind];
  if (!t) throw new Error(`noticeMail: 未知通知 ${kind}`);
  const [subject, line] = t[l];
  const tail = l === 'en'
    ? 'If this was not you, reset your password right away from the sign-in page.'
    : '如果不是你本人的操作，请立即在登录页用「忘记密码」重设密码。';
  const paras = [line, tail];
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return { subject, text: [...paras, when, SITE].join('\n\n'), html: wrapHtml([...paras, when]) };
}
