/**
 * server/hosted/auth/mailer.js — 事务邮件出口（验证码、安全通知）
 *
 * 服务商由环境变量选，业务代码只调 sendMail：
 *
 *   NODESIGN_MAIL_PROVIDER = ses | log | memory
 *     ses     Amazon SES v2 SendEmail（ops/aws/ses.yaml 建的身份与配置集）
 *     log     不发信，只打一行日志（开发 / exp 没配钥匙时）。正文默认不打，NODESIGN_MAIL_LOG_BODY=1 才打
 *     memory  测试用，发出的信进 sentMail 数组
 *   不设：钥匙齐了用 ses，否则 log。
 *
 *   NODESIGN_SES_REGION          默认 ap-northeast-1
 *   NODESIGN_SES_ACCESS_KEY_ID / NODESIGN_SES_SECRET_ACCESS_KEY   只能发信的 IAM 用户（栈输出 SenderUserName）
 *     ⚠️ 故意不用通用的 AWS_ACCESS_KEY_ID：那个名字会被机器上别的 AWS 工具顺手读走
 *   NODESIGN_SES_CONFIG_SET      默认 nodesign-ses-transactional（退信 / 投诉自动进抑制列表）
 *   NODESIGN_MAIL_FROM           默认 noreply@nodesign.xiaobuyu.trade（IAM 策略只允许这一个地址）
 *   NODESIGN_MAIL_FROM_NAME      默认 NoDesign
 */

import { signRequest } from './sigv4.js';

/** memory 模式下发出的信（测试读） */
export const sentMail = [];

export function mailProvider(env = process.env) {
  const p = String(env.NODESIGN_MAIL_PROVIDER || '').trim().toLowerCase();
  if (['ses', 'log', 'memory'].includes(p)) return p;
  return env.NODESIGN_SES_ACCESS_KEY_ID && env.NODESIGN_SES_SECRET_ACCESS_KEY ? 'ses' : 'log';
}

let warned = false;
export function warnIfMailUnconfigured() {
  if (warned) return;
  warned = true;
  const p = mailProvider();
  if (p === 'log') console.warn('[mail] ⚠️ 没有配置 SES 钥匙：验证码邮件不会真的发出去（NODESIGN_MAIL_PROVIDER=log）');
  if (p === 'ses' && !(process.env.NODESIGN_SES_ACCESS_KEY_ID && process.env.NODESIGN_SES_SECRET_ACCESS_KEY)) {
    console.warn('[mail] ⚠️ NODESIGN_MAIL_PROVIDER=ses 但钥匙不全，发信会失败');
  }
}

const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');

/** From 头：显示名含非 ASCII 时按 RFC 2047 编码（QQ 邮箱会检查 From 合法性） */
export function fromHeader(name, address) {
  if (!name) return address;
  const encoded = /^[\x20-\x7e]*$/.test(name)
    ? `"${name.replace(/["\\]/g, '')}"`
    : `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
  return `${encoded} <${address}>`;
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} mail
 * @throws 发信失败（调用方决定是报错给用户还是只记日志）
 */
export async function sendMail({ to, subject, text, html }) {
  const provider = mailProvider();
  if (provider === 'memory') {
    sentMail.push({ to, subject, text, html });
    return { provider, messageId: `mem-${sentMail.length}` };
  }
  if (provider === 'log') {
    console.log(`[mail:log] to=${mask(to)} subject=${JSON.stringify(subject)}`);
    if (process.env.NODESIGN_MAIL_LOG_BODY === '1') console.log(text);
    return { provider, messageId: null };
  }
  return sendViaSes({ to, subject, text, html });
}

async function sendViaSes({ to, subject, text, html }) {
  const env = process.env;
  const region = env.NODESIGN_SES_REGION || 'ap-northeast-1';
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const body = JSON.stringify({
    FromEmailAddress: fromHeader(env.NODESIGN_MAIL_FROM_NAME ?? 'NoDesign', env.NODESIGN_MAIL_FROM || 'noreply@nodesign.xiaobuyu.trade'),
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: text, Charset: 'UTF-8' },
          ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
    ConfigurationSetName: env.NODESIGN_SES_CONFIG_SET || 'nodesign-ses-transactional',
  });
  const headers = signRequest({
    method: 'POST', url, region, service: 'ses', body,
    headers: { 'content-type': 'application/json' },
    accessKeyId: env.NODESIGN_SES_ACCESS_KEY_ID || '',
    secretAccessKey: env.NODESIGN_SES_SECRET_ACCESS_KEY || '',
  });
  delete headers.host;   // fetch 自己写 Host，手动给会被拒
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  if (!res.ok) {
    let reason = raw.slice(0, 300);
    try { const j = JSON.parse(raw); reason = `${j.__type || j.code || ''} ${j.message || j.Message || ''}`.trim(); } catch { /* 非 JSON */ }
    console.warn(`[mail:ses] 发信失败 to=${mask(to)} status=${res.status} ${reason}`);
    throw Object.assign(new Error(`SES ${res.status}: ${reason}`), { code: 'MAIL_SEND_FAILED', status: res.status });
  }
  const j = JSON.parse(raw || '{}');
  return { provider: 'ses', messageId: j.MessageId || null };
}
