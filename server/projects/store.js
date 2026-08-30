/**
 * server/projects/store.js — Project DB（SQLite）
 *
 * 跟 runs/store.js 共享同一个 better-sqlite3 connection（import 即拿 db 实例）。
 *
 * 表 projects：
 *   id                  proj_<base36-ts>_<rand4>
 *   name                人类可读
 *   skill_id            默认 deskskill-engine-mini
 *   active_session_id   SDK query() 返回的 sessionId（用 query({ resume }) 续 turn）
 *   created_at / updated_at
 *
 * 同时给 runs 表加 project_id 列（ALTER 幂等），追溯 run 归属哪个 project。
 *
 * project 删除时由调用层负责级联删 workspace 目录 + 关联 runs。
 */

import db from '../engine/runs/store.js';

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    skill_id            TEXT NOT NULL DEFAULT 'deskskill-engine-mini',
    description         TEXT,
    active_session_id   TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
`);

// ALTER runs 加 project_id（幂等）
const runsCols = db.prepare('PRAGMA table_info(runs)').all();
if (!runsCols.some(c => c.name === 'project_id')) {
  db.exec('ALTER TABLE runs ADD COLUMN project_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_project_created ON runs(project_id, created_at DESC)');
  console.log('[projects/store] runs.project_id column added');
}

// 兼容老 DB：projects 表可能创建于 active_session_id 字段加入之前，
// 缺这列。CREATE TABLE IF NOT EXISTS 不会修改已存在表，需要 ALTER 补。
const projectsCols = db.prepare('PRAGMA table_info(projects)').all();
const projectsColNames = new Set(projectsCols.map(c => c.name));
if (!projectsColNames.has('active_session_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN active_session_id TEXT');
  console.log('[projects/store] projects.active_session_id column added (old DB compat)');
}

// S1：projects 表加 description 列（幂等）+ 一次性清洗老 active_session_id。
//
// 旧 active_session_id 全是无效值——之前 session-loop.js persistSession=false 时 SDK
// 不写 JSONL 但 setActiveSession 依然把 sessionId 写回（写不成功也被 turn.js
// 的 try/catch 吞掉，列存在时则成功写入幽灵 sid）。S1 切换 persistSession=true
// 之前必须把这些幽灵 sid 清掉，否则首次 resume 全 fail（兜底有 try/catch retry
// 但能少踩就少踩）。
//
// 清洗跟 description 加列绑定 — if 进过一次后 description 列存在，下次启动
// 不再进，自然只跑一次。
if (!projectsColNames.has('description')) {
  db.exec('ALTER TABLE projects ADD COLUMN description TEXT');
  db.exec("UPDATE projects SET active_session_id = NULL WHERE active_session_id IS NOT NULL");
  console.log('[projects/store] projects.description column added; active_session_id cleared');
}

// 入口流程重构：kind 区分「标准项目（project）」vs「闪聊（quick）」。
// 默认 'project' 让老数据零行为变化；闪聊由 Home 大输入框隐式建出，标 'quick'。
// 用户可在 Workspace 顶栏「升级为项目」把 quick → project（PATCH kind）。
if (!projectsColNames.has('kind')) {
  db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_projects_kind_updated ON projects(kind, updated_at DESC)");
  console.log('[projects/store] projects.kind column added (default project)');
}

// 首页入口重构（2026-07-28）：主页大输入框不再建"闪聊"，直接建真项目，
// 名字先用用户那句话垫着，第一轮跑完再用 SDK helper 写的会话摘要改名一次。
// auto_named=1 表示"这名字是系统垫的，可以被摘要覆盖"；用户一改名就清零。
if (!projectsColNames.has('auto_named')) {
  db.exec('ALTER TABLE projects ADD COLUMN auto_named INTEGER NOT NULL DEFAULT 0');
  console.log('[projects/store] projects.auto_named column added');
}

// 模式分离（2026-08-27）：design（设计工作台，现状）vs rp（演出：常驻角色演故事）。
// 两种模式共用全部基础设施（画布/黑板/会话/精灵），差异只在提示词分区与工具面
// （对照表在 engine/mcp/mode-profile.js 一份）。默认 'design' 让全部存量项目零行为变化。
// 会话启动时读一次 —— 切模式**下个会话生效**，跟"改人设下次上场生效"同一节奏。
if (!projectsColNames.has('mode')) {
  db.exec("ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'design'");
  console.log('[projects/store] projects.mode column added (default design)');
}

// 多用户内测（2026-07-30）：项目归属。NULL 的存量行由 bootstrapAuth() 回填 admin
if (!projectsColNames.has('owner_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at DESC)');
  console.log('[projects/store] projects.owner_id column added');
}

// 多用户内测（2026-07-30）：runs 计量真列 + 归属。原来 usage 全塞 metadata JSON
// （且值全 0，absorbResult 断链），配额查询要 sum，promote 成真列
const RUN_METRIC_COLS = [
  ['user_id', 'TEXT'],
  ['input_tokens', 'INTEGER'],
  ['output_tokens', 'INTEGER'],
  ['cache_read_tokens', 'INTEGER'],
  ['cache_create_tokens', 'INTEGER'],
  ['total_cost_usd', 'REAL'],
];
{
  const cols = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  let added = false;
  for (const [name, type] of RUN_METRIC_COLS) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      added = true;
    }
  }
  if (added) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs(user_id, created_at DESC)');
    console.log('[projects/store] runs 计量列 + user_id added');
  }
}

// 07-31 定案的欠账：runs 记会话归属 —— 回答"哪个会话最烧钱/最长"不用去数
// sessions/ 目录。存量行 NULL 不回填（目录里还能对出来，不值得写迁移）。
{
  const cols = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  if (!cols.has('session_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN session_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)');
    console.log('[projects/store] runs.session_id added');
  }
}

// ── ID ──

export function newProjectId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `proj_${ts}_${rand}`;
}

const PROJECT_ID_RE = /^proj_[a-z0-9_]{6,80}$/i;

export function validateProjectId(pid) {
  if (typeof pid !== 'string' || !PROJECT_ID_RE.test(pid)) {
    throw Object.assign(new Error(`非法 projectId: ${JSON.stringify(pid)}`), { code: 'INVALID_PROJECT_ID' });
  }
}

// ── 行 ↔ 对象 ──

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    skillId: row.skill_id,
    description: row.description || null,
    kind: row.kind || 'project',
    mode: row.mode || 'design',
    autoNamed: !!row.auto_named,
    ownerId: row.owner_id || null,
    activeSessionId: row.active_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD ──

/**
 * 列项目（按 updated_at 倒序）。
 * @param {object} opts
 * @param {string|null} opts.owner  **必填**：用户 id 只看自己的；null = 全量
 *   （admin / 内部调用显式声明）。做成必填是防"漏传就全库泄漏"——kind 的
 *   默认值语义已经踩过一次这种坑
 * @param {'project'|'quick'} [opts.kind]
 */
export function listProjects({ limit = 100, kind, owner } = {}) {
  if (owner === undefined) {
    throw new Error('listProjects: owner 必填（用户 id 或 null=全量）');
  }
  const wheres = [];
  const args = [];
  if (kind) { wheres.push('kind = ?'); args.push(kind); }
  if (owner !== null) { wheres.push('owner_id = ?'); args.push(owner); }
  const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM projects ${whereSql} ORDER BY updated_at DESC LIMIT ?`,
  ).all(...args, limit);
  return rows.map(rowToProject);
}

/** 读单条 */
export function getProject(id) {
  validateProjectId(id);
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return rowToProject(row);
}

/**
 * 创建 project。
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} [opts.skillId='deskskill-engine-mini']
 * @param {string} [opts.description]   人类可读的项目描述（agent 不读，仅 UI 用）
 * @param {'project'|'quick'} [opts.kind='project']  标准项目 / 闪聊（Home 隐式建）
 */
export function createProject({
  name,
  skillId = 'deskskill-engine-mini',
  description = null,
  kind = 'project',
  mode = 'design',
  autoNamed = false,
  ownerId = null,
}) {
  if (!name || typeof name !== 'string') throw new Error('createProject: name 必填');
  if (kind !== 'project' && kind !== 'quick') {
    throw new Error(`createProject: kind 非法 (${kind})`);
  }
  if (mode !== 'design' && mode !== 'rp') {
    throw new Error(`createProject: mode 非法 (${mode})`);
  }
  const id = newProjectId();
  const desc = (typeof description === 'string' && description.trim()) ? description.trim() : null;
  db.prepare(
    `INSERT INTO projects (id, name, skill_id, description, kind, mode, auto_named, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name.trim(), skillId, desc, kind, mode, autoNamed ? 1 : 0, ownerId);
  return getProject(id);
}

/** 更新（仅允许 name / skill_id / description / active_session_id / kind / mode / autoNamed） */
export function updateProject(id, patch) {
  validateProjectId(id);
  // 用户显式改名 = 这名字他自己定了，系统不再拿摘要覆盖
  if ('name' in patch && !('autoNamed' in patch)) patch = { ...patch, autoNamed: false };
  // kind 只允许枚举值（升级闪聊用 PATCH { kind: 'project' }）
  if ('kind' in patch && patch.kind !== 'project' && patch.kind !== 'quick') {
    throw new Error(`updateProject: kind 非法 (${patch.kind})`);
  }
  if ('mode' in patch && patch.mode !== 'design' && patch.mode !== 'rp') {
    throw new Error(`updateProject: mode 非法 (${patch.mode})`);
  }
  const map = {
    name: 'name',
    skillId: 'skill_id',
    description: 'description',
    activeSessionId: 'active_session_id',
    kind: 'kind',
    mode: 'mode',
    autoNamed: 'auto_named',
  };
  const sets = [];
  const args = [];
  for (const [camelK, sqlK] of Object.entries(map)) {
    if (camelK in patch) {
      sets.push(`${sqlK} = ?`);
      args.push(camelK === 'autoNamed' ? (patch[camelK] ? 1 : 0) : patch[camelK]);
    }
  }
  if (sets.length === 0) return getProject(id);
  sets.push("updated_at = datetime('now')");
  args.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getProject(id);
}

/** 删除（不级联 — 调用层负责删 workspace 目录 + 关联 runs） */
export function deleteProject(id) {
  validateProjectId(id);
  const row = db.prepare('DELETE FROM projects WHERE id = ? RETURNING *').get(id);
  return rowToProject(row);
}

/** 设置 active_session_id（封装常用） */
export function setActiveSession(projectId, sessionId) {
  return updateProject(projectId, { activeSessionId: sessionId });
}

/** 列 project 关联的 runs（用于级联清理） */
/**
 * 两个模式各自的用量（控制台那两张卡）。
 *
 * ⛔ **排掉站主自己**：他一个人的设计项目就比所有用户加起来还多，混进去这两个数
 *    就只是在量他自己。同仓口径，见 feedback-creative-tool-metrics。
 *
 * ⚠️ 两条查询分开跑不合并：runs 要 join run_model_usage 才拿得到钱，而那张表
 *    一个 run 有多行（一轮里换过几个模型就几行），并到项目那条里会把 projects
 *    乘出好几份。COUNT(DISTINCT) 能救回来，但读的人得先看出这里有个陷阱。
 *
 * @returns {Array<{mode, projects, users, runs, costUsd, firstAt}>}
 */
export function modeStats() {
  const HUMANS = "p.owner_id IN (SELECT id FROM users WHERE role <> 'admin')";
  const out = new Map();
  for (const r of db.prepare(
    `SELECT p.mode AS mode, COUNT(*) AS projects, COUNT(DISTINCT p.owner_id) AS users,
            MIN(p.created_at) AS firstAt
     FROM projects p WHERE ${HUMANS} GROUP BY p.mode`,
  ).all()) out.set(r.mode, { ...r, runs: 0, costUsd: 0 });

  for (const r of db.prepare(
    `SELECT p.mode AS mode, COUNT(DISTINCT r.id) AS runs,
            COALESCE(SUM(m.cost_usd), 0) AS costUsd
     FROM runs r
     JOIN projects p ON p.id = r.project_id
     LEFT JOIN run_model_usage m ON m.run_id = r.id
     WHERE ${HUMANS} GROUP BY p.mode`,
  ).all()) {
    const e = out.get(r.mode) || { mode: r.mode, projects: 0, users: 0, firstAt: null };
    out.set(r.mode, { ...e, runs: r.runs, costUsd: r.costUsd });
  }
  return [...out.values()];
}

export function listRunsForProject(projectId) {
  validateProjectId(projectId);
  return db.prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}
