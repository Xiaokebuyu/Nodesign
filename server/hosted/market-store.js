/**
 * server/hosted/market-store.js — skill 市场的存储层（2026-09-08 开线）
 *
 * 一条发布 = 一个 skill 包 + 几张参考图 + 标题说明。**不带产物本身**（站主 09-08 拍板：
 * 只要截图和 skill，不搬产物）。发布是快照：发布那一刻的 skill 字节存下来，作者之后改本地那份
 * 不影响货架上的；撤回也只是改状态，已经装到别人机器上的那份不动（要动那是 revoke，刀 2）。
 *
 * 状态机：pending（待审）→ approved / rejected（站主判）；作者可 withdrawn；站主可 revoked（已装的也失效）。
 * featured_rank 只对 approved 有意义：非空 = 精选，进所有人首页的项目区（数值小的靠前）。
 *
 * 文件：<MARKET_DIR>/<pubId>/skill.bin（原上传字节，装的时候再过一遍 validator）、
 *       <MARKET_DIR>/<pubId>/SKILL.md（第一个 skill 的正文，给详情页看，不参与安装）、
 *       <MARKET_DIR>/<pubId>/images/<n>.webp（参考图，最长边 1600、q80）。
 *
 * 表里存的是能查能排的字段；skill 的字节和图片只在磁盘。sharp 是 hosted 侧依赖，按需 import。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import db from '../engine/runs/store.js';
import { PROJECTS_DATA_ROOT } from '../projects/workspace.js';
import { getUserById } from '../auth/users-store.js';
import { avatarAt } from '../lib/avatar-store.js';

export const MARKET_DIR = process.env.VITEST
  ? path.join(os.tmpdir(), `nodesign-market-test-${process.pid}`)
  : path.resolve(process.env.NODESIGN_MARKET_DIR || path.join(PROJECTS_DATA_ROOT, '..', 'market-data'));

export const STATES = Object.freeze(['pending', 'approved', 'rejected', 'withdrawn', 'revoked']);
export const IMAGE_MAX_COUNT = 6;
export const IMAGE_MAX_UPLOAD = 8 * 1024 * 1024;   // 单张原图上限；缩完只剩几百 KB
export const IMAGE_MAX_EDGE = 1600;
export const TITLE_MAX = 80;
export const NOTE_MAX = 2000;
/** 首页项目区里给别人作品的位置：自己项目越多给得越少，到 0 为止 */
export const FEATURED_HOME_BASE = 6;

db.exec(`
  CREATE TABLE IF NOT EXISTS market_publications (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'skill',
    skill_name        TEXT NOT NULL,
    skill_version     TEXT,
    skill_description TEXT,
    skill_mode        TEXT,
    skill_sha256      TEXT NOT NULL,
    title             TEXT NOT NULL,
    note              TEXT,
    image_count       INTEGER NOT NULL DEFAULT 0,
    source            TEXT,
    showcase_id       TEXT,
    state             TEXT NOT NULL DEFAULT 'pending',
    review_note       TEXT,
    reviewed_by       TEXT,
    reviewed_at       TEXT,
    featured_rank     INTEGER,
    install_count     INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_market_pub_state ON market_publications(state, featured_rank, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_market_pub_user ON market_publications(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS market_installs (
    publication_id TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    skill_sha256   TEXT NOT NULL,
    source         TEXT,
    installed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (publication_id, user_id)
  );
`);

function newId() {
  return `pub_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function publicationDir(id) { return path.join(MARKET_DIR, id); }

function authorOf(userId) {
  const u = getUserById(userId);
  return { id: userId, username: u?.username || '?', avatarAt: u ? avatarAt(userId) : null };
}

function rowToPublication(row, { withAuthor = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    skillDescription: row.skill_description,
    skillMode: row.skill_mode,
    skillSha256: row.skill_sha256,
    title: row.title,
    note: row.note,
    imageCount: row.image_count,
    source: row.source,
    showcaseId: row.showcase_id,
    state: row.state,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    featuredRank: row.featured_rank,
    installCount: row.install_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(withAuthor ? { author: authorOf(row.user_id) } : {}),
  };
}

/** 参考图归一：最长边 IMAGE_MAX_EDGE、webp q80。坏图抛错（调用方回 400） */
export async function normalizeImage(buf) {
  const { default: sharp } = await import('sharp');
  return sharp(buf, { animated: false }).rotate()
    .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toBuffer();
}

/**
 * 落一条发布。skill 字节已经过 validateSkillUpload（validation 是它的返回），图片已经 normalize 过。
 * 全部文件先写进目录再插行；插行失败把目录删掉（别留孤儿目录）。
 */
export async function createPublication({ userId, skillBuffer, validation, skillMd, images, title, note, source, showcaseId }) {
  if (!userId) throw new Error('userId required');
  const id = newId();
  const dir = publicationDir(id);
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });
  try {
    await fs.writeFile(path.join(dir, 'skill.bin'), skillBuffer);
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd || '', 'utf8');
    for (let i = 0; i < images.length; i++) await fs.writeFile(path.join(dir, 'images', `${i}.webp`), images[i]);
    const first = validation.skills?.[0] || {};
    db.prepare(`INSERT INTO market_publications
      (id, user_id, skill_name, skill_version, skill_description, skill_mode, skill_sha256, title, note, image_count, source, showcase_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, validation.manifest.name, validation.manifest.version || first.version || null,
        first.description || validation.manifest.description || null, validation.mode || null,
        crypto.createHash('sha256').update(skillBuffer).digest('hex'),
        title, note ?? null, images.length, source ?? null, showcaseId ?? null);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return getPublication(id);
}

export function getPublication(id) {
  return rowToPublication(db.prepare('SELECT * FROM market_publications WHERE id = ?').get(id));
}

/** 货架：approved，精选靠前，其余按时间倒序 */
export function listApproved({ limit = 200 } = {}) {
  return db.prepare(`SELECT * FROM market_publications WHERE state = 'approved'
    ORDER BY (featured_rank IS NULL), featured_rank, created_at DESC LIMIT ?`).all(limit).map((r) => rowToPublication(r));
}

export function listByUser(userId) {
  return db.prepare('SELECT * FROM market_publications WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId).map((r) => rowToPublication(r));
}

/** 站主的审核台：按状态筛（all = 全部），时间倒序 */
export function listForAdmin({ state = 'pending', limit = 500 } = {}) {
  const rows = state === 'all'
    ? db.prepare('SELECT * FROM market_publications ORDER BY created_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM market_publications WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(state, limit);
  return rows.map((r) => rowToPublication(r));
}

export function countByState() {
  const out = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT state, COUNT(*) c FROM market_publications GROUP BY state').all()) out[r.state] = r.c;
  return out;
}

/** 首页给别人作品的位置数：自己有 own 个项目 → max(0, BASE - own) */
export function featuredSlotsFor(ownProjectCount, base = FEATURED_HOME_BASE) {
  const own = Math.max(0, Number(ownProjectCount) || 0);
  return Math.max(0, base - own);
}

/** 精选（approved 且 featured_rank 非空），排掉看的人自己的 */
export function listFeatured({ excludeUserId = null, limit = FEATURED_HOME_BASE } = {}) {
  if (limit <= 0) return [];
  return db.prepare(`SELECT * FROM market_publications
    WHERE state = 'approved' AND featured_rank IS NOT NULL AND (? IS NULL OR user_id <> ?)
    ORDER BY featured_rank, created_at DESC LIMIT ?`).all(excludeUserId, excludeUserId, limit).map((r) => rowToPublication(r));
}

/** 站主判：approved / rejected / revoked；批注可空。approved 以外一律清 featured_rank */
export function reviewPublication(id, { state, reviewNote = null, reviewedBy }) {
  if (!['approved', 'rejected', 'revoked'].includes(state)) throw new Error(`bad review state: ${state}`);
  const info = db.prepare(`UPDATE market_publications
    SET state = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now'),
        featured_rank = CASE WHEN ? = 'approved' THEN featured_rank ELSE NULL END
    WHERE id = ?`).run(state, reviewNote, reviewedBy, state, id);
  return info.changes > 0 ? getPublication(id) : null;
}

/** 加精 / 取消精选。只有 approved 能加精（别的状态传 rank 直接拒） */
export function setFeaturedRank(id, rank) {
  const pub = getPublication(id);
  if (!pub) return null;
  if (rank != null && pub.state !== 'approved') throw Object.assign(new Error('只有已通过的发布能加精'), { status: 409 });
  db.prepare("UPDATE market_publications SET featured_rank = ?, updated_at = datetime('now') WHERE id = ?")
    .run(rank == null ? null : Math.trunc(rank), id);
  return getPublication(id);
}

/** 作者撤回：pending / approved → withdrawn。别人的 / 已终态的 → false */
export function withdrawPublication(id, userId) {
  const info = db.prepare(`UPDATE market_publications
    SET state = 'withdrawn', featured_rank = NULL, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND state IN ('pending', 'approved')`).run(id, userId);
  return info.changes > 0;
}

export async function readSkillBuffer(id) {
  return fs.readFile(path.join(publicationDir(id), 'skill.bin'));
}

export async function readSkillMd(id) {
  try { return await fs.readFile(path.join(publicationDir(id), 'SKILL.md'), 'utf8'); } catch { return ''; }
}

export async function readImage(id, n) {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 0 || i >= IMAGE_MAX_COUNT) return null;
  try { return await fs.readFile(path.join(publicationDir(id), 'images', `${i}.webp`)); } catch { return null; }
}

/** 记一次安装（同一人重装不重复计数，但刷新 sha 和时间） */
export function recordInstall({ publicationId, userId, skillSha256, source = null }) {
  const existed = db.prepare('SELECT 1 FROM market_installs WHERE publication_id = ? AND user_id = ?').get(publicationId, userId);
  db.prepare(`INSERT INTO market_installs (publication_id, user_id, skill_sha256, source) VALUES (?, ?, ?, ?)
    ON CONFLICT(publication_id, user_id) DO UPDATE SET skill_sha256 = excluded.skill_sha256, source = excluded.source, installed_at = datetime('now')`)
    .run(publicationId, userId, skillSha256, source);
  if (!existed) db.prepare("UPDATE market_publications SET install_count = install_count + 1 WHERE id = ?").run(publicationId);
}

export function installedIdsFor(userId) {
  return new Set(db.prepare('SELECT publication_id FROM market_installs WHERE user_id = ?').all(userId).map((r) => r.publication_id));
}

/** 测试用：清空（只清表；文件目录按 pid 隔离，进程退出后由 OS 收） */
export function _resetForTest() {
  db.exec('DELETE FROM market_installs; DELETE FROM market_publications;');
}
