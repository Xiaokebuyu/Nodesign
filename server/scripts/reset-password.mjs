#!/usr/bin/env node
/**
 * server/scripts/reset-password.mjs — 命令行重置用户密码（直连 SQLite）
 *
 * 密码走 env 变量不走 argv（argv 会进 shell history / ps 可见）：
 *   NEW_PASSWORD='新密码' node server/scripts/reset-password.mjs admin
 *
 * 忘了 admin 密码时的标准恢复路径。改完立即生效（登录路径不走缓存）。
 */

import db from '../engine/runs/store.js';
import { getUserByUsername } from '../auth/users-store.js';
import { hashPassword } from '../hosted/users-write.js';   // 站主的运维脚本，只在服务器上跑（npm 包不带 scripts/）

const username = process.argv[2];
const password = process.env.NEW_PASSWORD;

if (!username || !password) {
  console.error("用法：NEW_PASSWORD='新密码' node server/scripts/reset-password.mjs <用户名>");
  process.exit(1);
}
if (password.length < 8) {
  console.error('密码至少 8 位');
  process.exit(1);
}
const user = getUserByUsername(username);
if (!user) {
  console.error(`用户不存在：${username}`);
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
console.log(`已重置 ${username} 的密码`);
