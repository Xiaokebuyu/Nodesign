/**
 * engine/runs/store.js — Run 数据库层（SQLite + better-sqlite3）
 *
 * Run 是 engine 的最小工作单元：一次 brief 触发，agent 自驱跑完 deskskill-engine 这类
 * skill，输出产物（deck.html）。每条 run 在 DB 里一行 + 在文件系统里一个 workspace 目录。
 *
 * 状态机（朴素版，MVP 够用，后续若加 cancel 优雅终止再改）：
 *   pending → running → succeeded
 *                    ↘ failed
 *                    ↘ cancelled
 *
 * 设计选择：
 *  - sync API：better-sqlite3 是有意 sync，社区共识是直接用，不假装 async
 *  - DB 路径：DB_PATH env > server/db/nodesign.db；目录不存在自动 mkdir
 *  - metadata 字段是 JSON TEXT：保留扩展空间（token usage / round / tool 摘要 / 关键日志），
 *    不强行落字段，等真实数据形态稳定后再 promote 成列
 *  - 不做 run_events 表：MVP 阶段 SSE 流即时推给前端就行；持久化审计是 P3+ 的事
 *  - id 形如 `run_<timestamp36>_<rand4>`：天然 sortable，方便 listRuns 默认逆序
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 默认放在 server/db/nodesign.db，跟 .env.example 的 DB_PATH 默认值对齐
const DEFAULT_DB_PATH = resolve(__dirname, '../../db/nodesign.db');
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;

// 自动 mkdir 父目录（干净部署首次启动不 ENOENT）
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    brief           TEXT NOT NULL,
    status          TEXT NOT NULL
                    CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
                    DEFAULT 'pending',
    artifact_path   TEXT,                         -- 主产物相对路径（相对 workspace），如 'deck.html'
    error           TEXT,                         -- 失败时的错误消息
    metadata        TEXT NOT NULL DEFAULT '{}',   -- JSON：token usage / rounds / 关键摘要等
    started_at      TEXT,                         -- 进入 running 的时间
    finished_at     TEXT,                         -- 进入终态的时间
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_skill_created ON runs(skill_id, created_at DESC);
`);

console.log(`[engine/runs] SQLite ready at ${DB_PATH}`);

// ── ID 生成 ──

/**
 * `run_<base36-timestamp>_<rand4>`
 * 例：run_lwx8mq3p_a7f2
 * 天然按时间字典序排序；不依赖 UUID 库。
 */
export function newRunId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `run_${ts}_${rand}`;
}

// ── 行 ↔ 对象 ──

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    skillId: row.skill_id,
    brief: row.brief,
    status: row.status,
    artifactPath: row.artifact_path,
    error: row.error,
    metadata: safeParseJson(row.metadata, {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ── 写入：CRUD ──

/**
 * 创建一个 pending 状态的 run。
 * @param {object} input
 * @param {string} input.skillId        - 要加载的 skill 名
 * @param {string} input.brief          - 用户输入
 * @param {object} [input.metadata={}]  - 初始元信息（如 client / requestId）
 * @returns {object} 完整 run 对象
 */
export function createRun({ skillId, brief, metadata = {} }) {
  if (!skillId || typeof skillId !== 'string') throw new Error('createRun: skillId 必填');
  if (!brief || typeof brief !== 'string') throw new Error('createRun: brief 必填');

  const id = newRunId();
  db.prepare(`
    INSERT INTO runs (id, skill_id, brief, status, metadata)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, skillId, brief, JSON.stringify(metadata));

  return getRun(id);
}

/** 读单条 */
export function getRun(id) {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return rowToRun(row);
}

/**
 * 列出最近的 runs。
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.status]   - 可选状态过滤
 * @param {string} [opts.skillId]  - 可选 skill 过滤
 */
export function listRuns({ limit = 50, status, skillId } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (skillId) { where.push('skill_id = ?'); args.push(skillId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const rows = db.prepare(
    `SELECT * FROM runs ${whereSql} ORDER BY created_at DESC LIMIT ?`
  ).all(...args);
  return rows.map(rowToRun);
}

// ── 状态转移：语义化函数（防止裸 SQL 散布到调用方）──

const updateStatusStmt = db.prepare(`
  UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?
`);

/** pending → running */
export function markRunStarted(id) {
  const row = db.prepare(`
    UPDATE runs
       SET status = 'running',
           started_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'
     RETURNING *
  `).get(id);
  if (!row) throw new Error(`markRunStarted: run ${id} 不存在或不在 pending 状态`);
  return rowToRun(row);
}

/** running → succeeded（带产物路径）*/
export function markRunSucceeded(id, { artifactPath } = {}) {
  const row = db.prepare(`
    UPDATE runs
       SET status = 'succeeded',
           artifact_path = ?,
           finished_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ? AND status = 'running'
     RETURNING *
  `).get(artifactPath || null, id);
  if (!row) throw new Error(`markRunSucceeded: run ${id} 不存在或不在 running 状态`);
  return rowToRun(row);
}

/** running → failed（带错误消息）*/
export function markRunFailed(id, errorMessage) {
  const msg = String(errorMessage || 'unknown error').slice(0, 4000); // 防爆
  const row = db.prepare(`
    UPDATE runs
       SET status = 'failed',
           error = ?,
           finished_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ? AND status IN ('pending', 'running')
     RETURNING *
  `).get(msg, id);
  if (!row) throw new Error(`markRunFailed: run ${id} 不存在或已是终态`);
  return rowToRun(row);
}

/** running/pending → cancelled（用户主动取消）*/
export function markRunCancelled(id) {
  const row = db.prepare(`
    UPDATE runs
       SET status = 'cancelled',
           finished_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ? AND status IN ('pending', 'running')
     RETURNING *
  `).get(id);
  if (!row) throw new Error(`markRunCancelled: run ${id} 不存在或已是终态`);
  return rowToRun(row);
}

// ── metadata 合并 ──

/**
 * 合并 metadata（浅合并）。常见用法：
 *   mergeRunMetadata(id, { roundCount: 3 })
 *   mergeRunMetadata(id, { tokenUsage: { input: 1234, output: 567 } })
 */
export function mergeRunMetadata(id, partial) {
  if (!partial || typeof partial !== 'object') return getRun(id);
  const current = getRun(id);
  if (!current) throw new Error(`mergeRunMetadata: run ${id} 不存在`);
  const merged = { ...current.metadata, ...partial };
  db.prepare(`
    UPDATE runs SET metadata = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(merged), id);
  return getRun(id);
}

// ── 调试用：清空（仅测试）──

/** ⚠️ 仅测试用 */
export function _truncateRunsTable() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('_truncateRunsTable: 禁止在 production 调用');
  }
  db.prepare('DELETE FROM runs').run();
}

export default db;
