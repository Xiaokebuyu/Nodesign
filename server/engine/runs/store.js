/**
 * engine/runs/store.js — Run 数据库层（SQLite，Node 自带的 node:sqlite）
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
 *  - sync API：node:sqlite 的 DatabaseSync 是有意 sync，直接用，不假装 async
 *  - 09-06 从 better-sqlite3 换过来：那是原生模块，ABI 锁运行时，桌面版打包为它折腾了一整轮；
 *    node:sqlite 是运行时自带的，Node ≥ 22.13 不用编译。两处口径差异在下面的薄壳里抹平
 *  - DB 路径：DB_PATH env > server/db/nodesign.db；目录不存在自动 mkdir
 *  - metadata 字段是 JSON TEXT：保留扩展空间（token usage / round / tool 摘要 / 关键日志），
 *    不强行落字段，等真实数据形态稳定后再 promote 成列
 *  - 不做 run_events 表：MVP 阶段 SSE 流即时推给前端就行；持久化审计是 P3+ 的事
 *  - id 形如 `run_<timestamp36>_<rand4>`：天然 sortable，方便 listRuns 默认逆序
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 默认放在 server/db/nodesign.db，跟 .env.example 的 DB_PATH 默认值对齐。
// ⛔ 但测试进程绝不许摸到这个默认值：vitest.server.config.js 里虽然配了测试库，
// **裸跑** `npx vitest run xxx.test.js`（不带 -c）根本不读那份配置 —— 08-17/08-18
// 两次就是这么把脏数据写进生产问题库的。config 层的兜底只护"跑对了命令"的人，
// 治本要在库自己身上：认出 VITEST 环境（vitest 恒设这个 env）就落到 tmp。
const DEFAULT_DB_PATH = process.env.VITEST
  ? join(tmpdir(), 'nodesign-vitest-bare.db')
  : resolve(__dirname, '../../db/nodesign.db');
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;

// 自动 mkdir 父目录（干净部署首次启动不 ENOENT）
mkdirSync(dirname(DB_PATH), { recursive: true });

// timeout = 忙等待（毫秒）。better-sqlite3 默认 5 秒；node:sqlite 默认 0 —— 生产上演出进程跟主进程共用
// 同一个库文件，不等就是 SQLITE_BUSY 直接炸。
const raw = new DatabaseSync(DB_PATH, { timeout: 5000 });
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

/**
 * 薄壳：对外还是 better-sqlite3 那套用法（db.prepare().get/all/run、db.exec、db.transaction），
 * 全仓几十个调用点一行不改。抹平的两处差异：
 *   1. 参数里的 undefined。better-sqlite3 当 NULL 绑，node:sqlite 抛 TypeError。可选字段传 undefined
 *      的调用点到处都是（label、metadata?.x……），靠测试盖不全，在这里统一归成 null。
 *      布尔和普通对象两边都抛，不动 —— 那是调用方的 bug，别替它藏。
 *   2. transaction：node:sqlite 没有这个助手，BEGIN / COMMIT / ROLLBACK 手写。不支持嵌套（全仓只有一处用）。
 */
const nullify = (v) => (v === undefined ? null : v);
const normArgs = (args) => args.map((a) => {
  if (a === undefined) return null;
  if (a && typeof a === 'object' && Object.getPrototypeOf(a) === Object.prototype) {
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, nullify(v)]));   // 具名参数 { name: v }
  }
  return a;
});
class Statement {
  constructor(stmt) { this.stmt = stmt; }
  get(...args) { return this.stmt.get(...normArgs(args)); }
  all(...args) { return this.stmt.all(...normArgs(args)); }
  run(...args) { return this.stmt.run(...normArgs(args)); }
  iterate(...args) { return this.stmt.iterate(...normArgs(args)); }
}
const db = {
  prepare: (sql) => new Statement(raw.prepare(sql)),
  exec: (sql) => raw.exec(sql),
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try { const out = fn(...args); raw.exec('COMMIT'); return out; }
      catch (err) { try { raw.exec('ROLLBACK'); } catch { /* 已经不在事务里 */ } throw err; }
    };
  },
  /** 底下那个 DatabaseSync，只给脚本和测试 */
  raw,
};

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

  -- 分模型用量明细（2026-07-31）。数据源 = SDK result.modelUsage 的会话内差分
  -- （modelUsage 是会话累计值，context.absorbResult 做差分后经 finishTurn 落这里）。
  -- model 键是 SDK 上报的原始模型串（如 'claude-sonnet-5'）；家族归并（sonnet/opus）
  -- 在查询侧做（lib/quota.js modelFamily），表里存原始值不丢信息。
  CREATE TABLE IF NOT EXISTS run_model_usage (
    run_id              TEXT NOT NULL,
    model               TEXT NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_create_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd            REAL NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, model)
  );
`);

console.log(`[engine/runs] SQLite ready at ${DB_PATH}`);

/**
 * 清扫僵尸 run：上个进程留下的 pending/running 行（server 重启时 SDK 子进程全死，
 * 这些 run 不可能再推进）标成 failed，否则永久停在 running（丢状态路径 P12）。
 *
 * **只能由 server 进程在启动时调一次**（server/index.js）。
 *
 * 2026-07-31 之前它是模块加载的副作用，后果是任何 import 到这个模块的东西都会
 * 把线上正在跑的 run 全部标成 failed —— 不只是调试用的 `node -e`，`invite.mjs`
 * 这种日常脚本也会（实测误杀了同一个用户的两轮对话，他那两轮的计量也一起丢了）。
 * 更糟的是 notice.mjs：它存在的意义就是在服务活着的时候发重启预告，一跑就清场。
 *
 * 判据很简单：清扫的前提是"上个进程已经死了"，只有 server 自己启动时才知道这件事
 * 成立。一个连接数据库的脚本对此一无所知，它凭什么替 server 宣布所有 run 都完了。
 */
export function sweepOrphanRuns() {
  try {
    const swept = db.prepare(`
      UPDATE runs SET status = 'failed', error = 'server restarted while run in flight',
        finished_at = datetime('now'), updated_at = datetime('now')
      WHERE status IN ('pending', 'running')
    `).run();
    if (swept.changes > 0) {
      console.log(`[engine/runs] swept ${swept.changes} orphaned run(s) from previous process`);
    }
    return swept.changes;
  } catch (err) {
    console.warn(`[engine/runs] orphan sweep failed:`, err.message);
    return 0;
  }
}

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
    // 归属 + 计量真列（2026-07-30 多用户；列由 projects/store.js 幂等 ALTER 加）
    projectId: row.project_id ?? null,
    userId: row.user_id ?? null,
    sessionId: row.session_id ?? null,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    cacheReadTokens: row.cache_read_tokens ?? null,
    cacheCreateTokens: row.cache_create_tokens ?? null,
    totalCostUsd: row.total_cost_usd ?? null,
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
 * @param {string} input.skillId           - 要加载的 skill 名
 * @param {string} input.brief             - 用户输入
 * @param {string} [input.projectId=null]  - 归属 project（P0 turn endpoint 必传）
 * @param {object} [input.metadata={}]     - 初始元信息（如 client / requestId）
 * @returns {object} 完整 run 对象
 */
export function createRun({ skillId, brief, projectId = null, userId = null, sessionId = null, metadata = {} }) {
  if (!skillId || typeof skillId !== 'string') throw new Error('createRun: skillId 必填');
  if (!brief || typeof brief !== 'string') throw new Error('createRun: brief 必填');

  const id = newRunId();
  db.prepare(`
    INSERT INTO runs (id, skill_id, brief, project_id, user_id, session_id, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, skillId, brief, projectId, userId, sessionId, JSON.stringify(metadata));

  return getRun(id);
}

/**
 * 落计量真列（2026-07-30）：turn 收尾时从 ctx.counters 写。列是配额 sum 的
 * 数据源（metadata JSON 里同样有一份完整 counters 做审计）。
 */
export function setRunMetrics(id, {
  inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, totalCostUsd,
} = {}) {
  db.prepare(`
    UPDATE runs SET
      input_tokens = ?, output_tokens = ?,
      cache_read_tokens = ?, cache_create_tokens = ?,
      total_cost_usd = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    inputTokens ?? 0, outputTokens ?? 0,
    cacheReadTokens ?? 0, cacheCreateTokens ?? 0,
    totalCostUsd ?? 0, id,
  );
}

/**
 * 落分模型明细（2026-07-31）。deltasByModel 形如
 * { 'claude-sonnet-5': { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd } }
 * 值语义是"本 turn 增量"（差分在 context.absorbResult 做完）。用 upsert 覆盖而非
 * 累加：一个 turn 只有一条 result，防御性重复调用不应把数字翻倍。
 */
const upsertModelUsage = db.prepare(`
  INSERT INTO run_model_usage (run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, model) DO UPDATE SET
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_create_tokens = excluded.cache_create_tokens,
    cost_usd = excluded.cost_usd
`);

export function setRunModelUsage(runId, deltasByModel) {
  if (!runId || !deltasByModel || typeof deltasByModel !== 'object') return;
  for (const [model, d] of Object.entries(deltasByModel)) {
    if (!model || !d) continue;
    upsertModelUsage.run(
      runId, model,
      d.inputTokens ?? 0, d.outputTokens ?? 0,
      d.cacheReadTokens ?? 0, d.cacheCreateTokens ?? 0,
      d.costUsd ?? 0,
    );
  }
}

/** 某 run 的分模型明细（审计 / 前端展示用） */
export function getRunModelUsage(runId) {
  return db.prepare(
    'SELECT model, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_create_tokens AS cacheCreateTokens, cost_usd AS costUsd FROM run_model_usage WHERE run_id = ?',
  ).all(runId);
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
