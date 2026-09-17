/**
 * server/projects/deletion-log.js — 项目删除 / 恢复 / 彻底删除的审计账（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 09-02 那次「工作区被清空」能定案，靠的是 14 天就轮转掉的 nginx 访问日志：删除路由本身一行记录都没留。
 * 所以每次删除、恢复、彻底删除（含到期自动清理）各记一条，谁、什么时候、删了哪个、当时有几个会话在跑、
 * 工作区多大、结果如何。
 *
 * 为什么落数据库表而不是数据目录下的追加日志：
 *   - 管理员要按项目 / 时间查（接口 GET /api/projects/trash/log），表直接能查，追加文件得自己解析和轮转；
 *   - 同仓的「要给管理员查的记录」都是表（issues、published_sites、moderation flags），备份跟着库走；
 *   - 数据根在沙盒里整个禁读，库文件也不在 agent 可读范围内，隐私面不比日志文件大。
 * 这张表只增不改；项目名照记（行被彻底删除之后，这里是唯一还能对上 pid 和名字的地方）。
 */
import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS project_deletion_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    at               TEXT NOT NULL,
    action           TEXT NOT NULL,          -- delete | restore | purge
    reason           TEXT,                   -- user | expired | folder-reopen
    project_id       TEXT NOT NULL,
    project_name     TEXT,
    owner_id         TEXT,
    actor_id         TEXT,                   -- 到期清理时为 NULL
    actor_is_admin   INTEGER NOT NULL DEFAULT 0,
    active_sessions  INTEGER,
    workspace_bytes  INTEGER,
    workspace_files  INTEGER,
    result           TEXT NOT NULL,          -- ok | partial | error
    detail           TEXT,
    duration_ms      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_deletion_log_project ON project_deletion_log(project_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_deletion_log_at ON project_deletion_log(at DESC);
`);

const ACTIONS = new Set(['delete', 'restore', 'purge']);

/**
 * 记一条。**不抛**：审计写不进去不能反过来挡住删除本身，写失败只记服务端日志。
 * @returns {number|null} 行 id
 */
export function recordDeletionEvent({
  action, reason = 'user', project = null, projectId = project?.id, actor = null,
  activeSessions = null, bytes = null, files = null, result = 'ok', detail = null, durationMs = null,
  at = new Date().toISOString(),
}) {
  try {
    if (!ACTIONS.has(action)) throw new Error(`unknown action ${action}`);
    const info = db.prepare(`INSERT INTO project_deletion_log
      (at, action, reason, project_id, project_name, owner_id, actor_id, actor_is_admin,
       active_sessions, workspace_bytes, workspace_files, result, detail, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      at, action, reason, projectId, project?.name ?? null, project?.ownerId ?? null,
      actor?.id ?? null, actor?.role === 'admin' ? 1 : 0,
      activeSessions, bytes, files, result, detail == null ? null : String(detail).slice(0, 2000),
      durationMs == null ? null : Math.round(durationMs),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    console.error(`[deletion-log] 审计写入失败 ${action} ${projectId}: ${err.message}`);
    return null;
  }
}

function rowToEvent(r) {
  return {
    id: r.id, at: r.at, action: r.action, reason: r.reason,
    projectId: r.project_id, projectName: r.project_name, ownerId: r.owner_id,
    actorId: r.actor_id, actorIsAdmin: !!r.actor_is_admin,
    activeSessions: r.active_sessions, workspaceBytes: r.workspace_bytes, workspaceFiles: r.workspace_files,
    result: r.result, detail: r.detail, durationMs: r.duration_ms,
  };
}

/** 新的在前。projectId 可选；limit 上限 500 */
export function listDeletionEvents({ projectId = null, limit = 100 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = projectId
    ? db.prepare('SELECT * FROM project_deletion_log WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, n)
    : db.prepare('SELECT * FROM project_deletion_log ORDER BY id DESC LIMIT ?').all(n);
  return rows.map(rowToEvent);
}

/** 这个 pid 有没有被删过的记录（存在性闸在测试宽松模式下兜底用，见 project-gone.js） */
export function hasDeletionRecord(projectId) {
  return !!db.prepare("SELECT 1 FROM project_deletion_log WHERE project_id = ? AND action IN ('delete', 'purge') LIMIT 1").get(projectId);
}
