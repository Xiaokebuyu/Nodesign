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
 */
export function createProject({ name, skillId = 'deskskill-engine-mini' }) {
  if (!name || typeof name !== 'string') throw new Error('createProject: name 必填');
  const id = newProjectId();
  db.prepare(`INSERT INTO projects (id, name, skill_id) VALUES (?, ?, ?)`).run(
    id, name.trim(), skillId,
  );
  return getProject(id);
}

/** 更新（仅允许 name / skill_id / active_session_id） */
export function updateProject(id, patch) {
  validateProjectId(id);
  const map = { name: 'name', skillId: 'skill_id', activeSessionId: 'active_session_id' };
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
