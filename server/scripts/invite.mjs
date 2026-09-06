#!/usr/bin/env node
/**
 * server/scripts/invite.mjs — 命令行生成邀请码（不走 HTTP，直连 SQLite）
 *
 * 用法（项目根目录）：
 *   node server/scripts/invite.mjs                 生成 1 个单次邀请码
 *   node server/scripts/invite.mjs --uses 5        可用 5 次
 *   node server/scripts/invite.mjs --days 7        7 天后过期
 *   node server/scripts/invite.mjs --uses 100 --grant-usd 15
 *       通用试用码（放简历/公开场合）：该码注册的号终身 $15 不刷新
 *   node server/scripts/invite.mjs --list          列出全部邀请码与用量
 */

import { createInvite, listInvites } from '../hosted/users-write.js';   // 站主的运维脚本，只在服务器上跑（npm 包不带 scripts/）

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

if (args.includes('--list')) {
  for (const inv of listInvites()) {
    const state = inv.expires_at && new Date(inv.expires_at) < new Date() ? '已过期'
      : inv.used_count >= inv.max_uses ? '已用完' : '可用';
    const grant = inv.grant_lifetime_usd ? `  试用终身$${inv.grant_lifetime_usd}` : '';
    console.log(`${inv.code}  ${inv.used_count}/${inv.max_uses}  ${state}${grant}${inv.expires_at ? `  过期 ${inv.expires_at}` : ''}`);
  }
  process.exit(0);
}

const maxUses = Number(flag('uses')) || 1;
const days = Number(flag('days'));
const expiresAt = Number.isFinite(days) && days > 0
  ? new Date(Date.now() + days * 86400_000).toISOString() : null;
const grantUsd = Number(flag('grant-usd'));
const invite = createInvite({
  createdBy: 'cli', maxUses, expiresAt,
  grantLifetimeUsd: Number.isFinite(grantUsd) && grantUsd > 0 ? grantUsd : null,
});
console.log(invite.code);
