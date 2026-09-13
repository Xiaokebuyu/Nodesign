/**
 * server/hosted/auth/identities-store.js — 第三方登录身份（Google / GitHub）与账号的关联
 *
 * 主键 (provider, subject)：Google 用 ID token 的 `sub`，GitHub 用数字 id。**不用邮箱当标识**（OIDC Core §5.7：
 * email 不能当唯一标识；GitHub 的 login 可以改名）。一个账号每家最多关联一个。
 */

import db from '../../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS user_identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user_provider ON user_identities(user_id, provider);
`);

export const PROVIDERS = ['google', 'github'];

export function findIdentity(provider, subject) {
  return db.prepare('SELECT * FROM user_identities WHERE provider = ? AND subject = ?').get(provider, String(subject)) || null;
}

export function listIdentities(userId) {
  return db.prepare('SELECT provider, email, created_at FROM user_identities WHERE user_id = ? ORDER BY created_at ASC').all(userId);
}

/**
 * 关联。已被别的账号占用抛 IDENTITY_TAKEN；这个账号已经关联了同一家的另一个身份抛 PROVIDER_ALREADY_LINKED。
 * 同一个身份重复关联到同一个账号：幂等返回。
 */
export function linkIdentity({ provider, subject, userId, email = null, now = Date.now() }) {
  const existing = findIdentity(provider, subject);
  if (existing) {
    if (existing.user_id === userId) return existing;
    throw Object.assign(new Error('identity already linked to another account'), { code: 'IDENTITY_TAKEN' });
  }
  const sameProvider = db.prepare('SELECT 1 FROM user_identities WHERE user_id = ? AND provider = ?').get(userId, provider);
  if (sameProvider) throw Object.assign(new Error('account already linked to this provider'), { code: 'PROVIDER_ALREADY_LINKED' });
  db.prepare('INSERT INTO user_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(provider, String(subject), userId, email, now);
  return findIdentity(provider, subject);
}

export function unlinkIdentity(userId, provider) {
  return db.prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, provider).changes > 0;
}
