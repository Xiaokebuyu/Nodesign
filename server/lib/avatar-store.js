/**
 * server/lib/avatar-store.js — 用户头像（2026-09-07 站主：桌面版顶栏跟网页版对齐，顺手加头像自定义）
 *
 * 存在 users.avatar（BLOB，128×128 webp，几 KB），跟账号一起备份、一起删；不另开目录。
 * 入口三条：网页端 PUT /api/me/avatar、桌面版经 relay PUT /api/relay/avatar（设备令牌）、都落到 setAvatar。
 * 出口：网页端 GET /api/me/avatar 直接出图；桌面版从 relay /whoami 里拿 data URL（几 KB，跟身份一起缓存在目录里）。
 * sharp 是 hosted 侧的依赖（客户端包里没有），所以按需 import，本地版永远不走到。
 */
import db from '../engine/runs/store.js';

export const AVATAR_SIZE = 128;
export const AVATAR_MAX_UPLOAD = 2 * 1024 * 1024;   // 原图上限 2MB；再大的先自己缩一下

// users 表由 auth/users-store.js 建；本地版进程里可能压根没有这张表（没有账号这回事），那就什么都不做
const avatarCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (avatarCols.size && !avatarCols.has('avatar')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar BLOB');
  db.exec('ALTER TABLE users ADD COLUMN avatar_at TEXT');
  console.log('[avatar-store] users.avatar / avatar_at columns added');
}

/** 原图 → 128×128 居中裁 webp。不是图 / 解不开 → 抛错（调用方映射成 400） */
export async function normalizeAvatar(buf) {
  if (!buf || !buf.length) throw new Error('empty image');
  if (buf.length > AVATAR_MAX_UPLOAD) throw new Error(`image too large (> ${AVATAR_MAX_UPLOAD / 1024 / 1024}MB)`);
  const { default: sharp } = await import('sharp');
  return sharp(buf, { animated: false }).rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 }).toBuffer();
}

export async function setAvatar(userId, buf) {
  const webp = await normalizeAvatar(buf);
  db.prepare("UPDATE users SET avatar = ?, avatar_at = datetime('now') WHERE id = ?").run(webp, userId);
  return webp;
}

export function clearAvatar(userId) {
  db.prepare('UPDATE users SET avatar = NULL, avatar_at = NULL WHERE id = ?').run(userId);
}

/** @returns {{ buf: Buffer, at: string } | null} */
export function getAvatar(userId) {
  const row = db.prepare('SELECT avatar, avatar_at FROM users WHERE id = ?').get(userId);
  if (!row?.avatar) return null;
  return { buf: Buffer.from(row.avatar), at: row.avatar_at };
}

export function avatarAt(userId) {
  return db.prepare('SELECT avatar_at FROM users WHERE id = ?').get(userId)?.avatar_at || null;
}

/** 桌面版走 whoami 带回去的形状：data URL（几 KB） */
export function avatarDataUrl(userId) {
  const a = getAvatar(userId);
  return a ? `data:image/webp;base64,${a.buf.toString('base64')}` : null;
}
