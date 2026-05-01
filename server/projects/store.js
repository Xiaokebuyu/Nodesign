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
// 旧 active_session_id 全是无效值——之前 loop.js persistSession=false 时 SDK
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
    activeSessionId: row.active_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD ──

/** 列项目（按 updated_at 倒序） */
export function listProjects({ limit = 100 } = {}) {
  const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?').all(limit);
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
 */
export function createProject({ name, skillId = 'deskskill-engine-mini', description = null }) {
  if (!name || typeof name !== 'string') throw new Error('createProject: name 必填');
  const id = newProjectId();
  const desc = (typeof description === 'string' && description.trim()) ? description.trim() : null;
  db.prepare(`INSERT INTO projects (id, name, skill_id, description) VALUES (?, ?, ?, ?)`).run(
    id, name.trim(), skillId, desc,
  );
  return getProject(id);
}

/** 更新（仅允许 name / skill_id / description / active_session_id） */
export function updateProject(id, patch) {
  validateProjectId(id);
  const map = {
    name: 'name',
    skillId: 'skill_id',
    description: 'description',
    activeSessionId: 'active_session_id',
  };
  const sets = [];
  const args = [];
  for (const [camelK, sqlK] of Object.entries(map)) {
    if (camelK in patch) {
      sets.push(`${sqlK} = ?`);
      args.push(patch[camelK]);
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
export function listRunsForProject(projectId) {
  validateProjectId(projectId);
  return db.prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}
