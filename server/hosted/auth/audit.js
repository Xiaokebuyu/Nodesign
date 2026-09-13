/**
 * server/hosted/auth/audit.js — 账号安全事件（只落表，查询走命令行）
 *
 * 记什么：登录成功 / 失败、注册、找回密码、改密码、改邮箱、改用户名、吊销会话。
 * 不记什么：密码、验证码、令牌明文；邮箱只在 detail 里出现用户自己的那一个。
 *
 *   sqlite3 server/db/nodesign.db "select datetime(created_at/1000,'unixepoch','+8 hours'), type, user_id, ip, detail
 *     from auth_events order by id desc limit 50"
 */

import db from '../../engine/runs/store.js';
import { clientIp } from './client-ip.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    type TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id, created_at);
`);

/**
 * @param {string} type  login_ok / login_fail / register / code_login / password_reset / password_change /
 *                       email_change / username_change / sessions_revoke / session_revoke
 */
export function recordAuthEvent(type, { userId = null, req = null, detail = null } = {}) {
  try {
    db.prepare('INSERT INTO auth_events (user_id, type, ip, user_agent, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, type, req ? clientIp(req) : null, req ? String(req.headers?.['user-agent'] || '').slice(0, 300) : null,
        detail == null ? null : JSON.stringify(detail), Date.now());
  } catch (err) {
    // 审计写不进去不能挡住登录本身
    console.warn(`[auth-audit] 写入失败：${err.message}`);
  }
}
