#!/usr/bin/env node
/**
 * server/scripts/mail-suppression.mjs — 查看与解除本地发信抑制名单（不走 HTTP，直连 SQLite）
 *
 * 退信 / 投诉事件由 SNS 打到 /api/ses/events（server/hosted/auth/ses-events.js），永久退信和
 * 投诉的地址会进抑制名单，之后发不出验证码。误伤或者对方修好了邮箱，用这个脚本解除。
 *
 * 用法（项目根目录，跑之前确认 DB_PATH 指的是生产库）：
 *   node --env-file-if-exists=.env server/scripts/mail-suppression.mjs                     列出抑制名单
 *   node --env-file-if-exists=.env server/scripts/mail-suppression.mjs --events            最近 50 条事件
 *   node --env-file-if-exists=.env server/scripts/mail-suppression.mjs --events a@b.com    这个地址的事件
 *   node --env-file-if-exists=.env server/scripts/mail-suppression.mjs --remove a@b.com    解除抑制
 *
 * ⛔ 解除之后 AWS 账号级抑制列表仍可能拦着这个地址（那是另一份名单，在 SES 那边）。
 *    真要让它重新收得到信，还要 aws sesv2 delete-suppressed-destination --email-address …
 */

import { listSuppressed, listFeedback, unsuppressEmail } from '../hosted/auth/mail-suppression.js';

const args = process.argv.slice(2);
const at = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

if (args[0] === '--remove') {
  const email = args[1];
  if (!email) {
    console.error('用法：--remove <邮箱>');
    process.exit(1);
  }
  console.log(unsuppressEmail(email) ? `已解除 ${email}` : `${email} 不在抑制名单上（或者不是合法邮箱形状）`);
  process.exit(0);
}

if (args[0] === '--events') {
  const rows = listFeedback({ email: args[1] || null, limit: 50 });
  if (!rows.length) console.log('没有记录');
  for (const r of rows) {
    console.log(`${at(r.at)}  ${r.event_type.padEnd(14)} ${String(r.email || '-').padEnd(32)} ${r.subtype || '-'}  ${r.detail || ''}`);
  }
  process.exit(0);
}

const rows = listSuppressed({ limit: 500 });
if (!rows.length) console.log('抑制名单是空的');
for (const r of rows) console.log(`${at(r.at)}  ${r.reason.padEnd(10)} ${r.email.padEnd(32)} ${r.detail || ''}`);
