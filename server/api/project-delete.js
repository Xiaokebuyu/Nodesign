/**
 * server/api/project-delete.js — 删除项目（进回收站）与回收站接口（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 *   DELETE /api/projects/:pid                  → softDeleteProject（projects.js 调）
 *   GET    /api/projects/trash                 → 我的最近删除（管理员 ?all=1 看全站）
 *   POST   /api/projects/trash/:pid/restore    → 恢复
 *   DELETE /api/projects/trash/:pid            → 立即彻底删除
 *   GET    /api/projects/trash/log             → 删除审计（仅管理员）
 *
 * ## 删除的顺序（为什么是这个顺序）
 *
 * 09-02 那次：删除路由先 rm 目录、会话照跑，agent 下一次写画布经 ensureProjectWorkspace 把工作区整套重建。
 * 09-05 补的「先关会话」其实没生效：`for (const sid of listSessionsForProject(pid))` 迭代的是一个 Promise
 * （那个函数是 async，而且给的是会话对象不是 sid），抛 TypeError 被 catch 吞掉 —— 一个会话都没关过。
 * 现在：
 *   ① 先立删除标记。从这一刻起 getProject 查不到它，所有经存在性闸（projects/project-gone.js）的写入口拒绝；
 *   ② 关这个项目在册的会话（active-runs 按 projectId 列，不再读磁盘）；
 *   ③ 停浏览器、产物会话、演出进程、后台进程，停项目总线上带计时器的订阅者（入座器、对账）；
 *   ④ 等会话真正退出（runSession 的收尾走完，含回合末的提交），最多 10 秒；
 *   ⑤ 整个项目目录挪进回收站，原路径立占位文件（迟到的写入撞上 ENOTDIR，长不回来）；
 *   ⑥ 记审计。
 * 挪不动（Windows 文件占用，退避重试后仍失败）时项目照样算删除，工作区留在原处，到期清理时删；
 * 结果记 partial，响应带 warning。
 *
 * ## 发布出去的东西（跟 09-17 之前保持一致）
 * - 已发布站点（published_sites / Cloudflare Pages）：删除从来不动它们，站点继续在线、继续占发布名额。
 *   回收站列表里带上在线站点数，用户要下线得先恢复项目再下线。
 * - 市场发布：发布时图片与 skill 已拷进 market-data，跟项目目录无关，不动。
 * - 橱窗卡片：以前删除时立刻删；现在保留期内留着（恢复后照常可用，期间 projectAlive=false 显示为失效），
 *   彻底删除时才删。
 * - runs：以前连带删（run_model_usage 因此成了查不到人的孤儿账），现在一律保留。
 */
import express from 'express';
import {
  getProjectIncludingDeleted, listDeletedProjects, markProjectDeleted, setProjectTrashDir, validateProjectId,
} from '../projects/store.js';
import { getProjectWorkspace } from '../projects/workspace.js';
import { moveWorkspaceToTrash, measureDir, trashRetentionDays, purgeAfter, trashPathOf } from '../projects/project-trash.js';
import { withProjectLock, restoreDeletedProject, purgeDeletedProject } from '../projects/trash-lifecycle.js';
import { recordDeletionEvent, listDeletionEvents } from '../projects/deletion-log.js';
import { disposeProjectBus } from '../ws/broker.js';
import { stopStagesForProject } from '../engine/stage/manager.js';
import {
  closeQuerySession, getCurrentTurnRunId, listQuerySessionIdsForProject, waitForProjectSessionsExit,
} from '../engine/runs/active-runs.js';
import { stopProcessesForProject } from '../engine/process/registry.js';
import { listPublishedByProject } from '../lib/publish-store.js';

export const SESSION_EXIT_WAIT_MS = 10_000;

/** 会往工作区写东西的常驻件。浏览器 / 产物会话动态 import：别把 playwright 拖进路由的启动图 */
export const DEFAULT_STOPPERS = {
  browser: async (pid) => (await import('../engine/browse/registry.js')).closeFor(pid, 'project deleted'),
  artifactSession: async (pid) => (await import('../engine/perception/session.js')).closeSession(pid, 'project deleted'),
  stages: (pid) => stopStagesForProject(pid, 'project-deleted'),
  processes: (pid) => stopProcessesForProject(pid, 'project-deleted'),
};

/**
 * 把一个活项目删进回收站。调用方已做过归属校验（guardProject）。
 * @param {object} project  getProject 形状
 * @param {object} [opts.actor]  req.user（审计）
 * @param {Function} [opts.move]  挪目录（测试注入 Windows 占用失败）
 * @returns {Promise<{ deletedAt: string, purgeAfter: string|null, retentionDays: number, activeSessions: number, result: string, warning: string|null }>}
 */
export function softDeleteProject(project, { actor = null, waitMs = SESSION_EXIT_WAIT_MS, stoppers = DEFAULT_STOPPERS, move = moveWorkspaceToTrash } = {}) {
  const pid = project.id;
  return withProjectLock(pid, async () => {
    const started = Date.now();
    const notes = [];
    const deletedAt = new Date().toISOString();
    markProjectDeleted(pid, deletedAt);                                       // ①

    const sids = listQuerySessionIdsForProject(pid);                          // ②
    const turns = sids.filter((sid) => getCurrentTurnRunId(sid)).length;
    for (const sid of sids) closeQuerySession(sid, 'project_deleted');

    for (const [name, stop] of Object.entries(stoppers)) {                    // ③
      try { await stop(pid); } catch (err) { notes.push(`${name} 没停干净：${err.message}`); }
    }
    disposeProjectBus(pid);

    const wait = await waitForProjectSessionsExit(pid, waitMs);               // ④
    if (wait.pending) notes.push(`${wait.pending} 个会话 ${waitMs}ms 内没退出，照常挪目录`);

    let moved;                                                                // ⑤
    try {
      moved = await move(pid);
    } catch (err) {
      moved = { trashDir: null, tombstone: false, moveError: `${err.code || 'ERR'}: ${err.message}`, stray: null };
    }
    if (moved.trashDir) setProjectTrashDir(pid, moved.trashDir);
    if (moved.moveError) notes.push(`工作区没能移进回收站（${moved.moveError}），留在原处，到期清理时删除`);
    if (moved.stray) notes.push(`原路径上迟到写入建出的目录一并移进回收站：${moved.stray}`);
    if (!moved.moveError && !moved.tombstone) notes.push('原路径的占位文件没立上');

    const sizeDir = moved.trashDir ? trashPathOf(moved.trashDir) : (moved.moveError ? getProjectWorkspace(pid) : null);
    const size = sizeDir ? await measureDir(sizeDir).catch(() => null) : null;
    if (size?.truncated) notes.push('大小只统计了前 5 万个条目');
    const result = (moved.moveError || wait.pending || !moved.tombstone) ? 'partial' : 'ok';
    recordDeletionEvent({                                                     // ⑥
      action: 'delete', reason: 'user', project, actor, at: deletedAt,
      activeSessions: sids.length, bytes: size?.bytes ?? null, files: size?.files ?? null, result,
      detail: [`在册会话 ${sids.length}（在跑回合 ${turns}）`, moved.trashDir ? `→ ${moved.trashDir}` : '删除时没有工作区目录', ...notes].join('；'),
      durationMs: Date.now() - started,
    });
    const days = trashRetentionDays();
    return {
      deletedAt, purgeAfter: purgeAfter(deletedAt, days), retentionDays: days,
      activeSessions: sids.length, result,
      warning: moved.moveError ? '项目已删除，但工作区文件正被占用，没能移进回收站；恢复不受影响。' : null,
    };
  });
}

// ── 回收站接口 ──

const isAdmin = (req) => req.user?.role === 'admin';

/** 回收站里的项目 + 归属校验。不在回收站 / 不是自己的（管理员例外）一律 404，同 guardProject 的口径 */
function guardTrashed(req, res) {
  try { validateProjectId(req.params.pid); } catch (err) {
    res.status(400).json({ error: err.message || 'invalid projectId' });
    return null;
  }
  const row = getProjectIncludingDeleted(req.params.pid);
  const mine = row && (isAdmin(req) || (typeof req.user?.id === 'string' && row.ownerId === req.user.id));
  if (!row?.deletedAt || !mine) {
    res.status(404).json({ error: 'not in trash', code: 'NOT_IN_TRASH' });
    return null;
  }
  return row;
}

function trashView(row, days) {
  return {
    id: row.id, name: row.name, kind: row.kind, mode: row.mode, ownerId: row.ownerId,
    folderPath: row.folderPath, isSample: row.isSample, updatedAt: row.updatedAt,
    deletedAt: row.deletedAt, purgeAfter: purgeAfter(row.deletedAt, days),
    // 删除不下线已发布站点（见头注）：列出来让用户知道它们还在线
    publishedSites: listPublishedByProject(row.id).length,
  };
}

export const trashRouter = express.Router();

trashRouter.get('/', (req, res, next) => {
  try {
    const all = isAdmin(req) && req.query.all === '1';
    const days = trashRetentionDays();
    const rows = listDeletedProjects({ owner: all ? null : (req.user?.id ?? null) });
    res.json({ retentionDays: days, projects: rows.map((r) => trashView(r, days)) });
  } catch (err) { next(err); }
});

trashRouter.get('/log', (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only', code: 'FORBIDDEN' });
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
    res.json({ events: listDeletionEvents({ projectId, limit: Number(req.query.limit) || 100 }) });
  } catch (err) { next(err); }
});

trashRouter.post('/:pid/restore', async (req, res, next) => {
  try {
    const row = guardTrashed(req, res);
    if (!row) return;
    const project = await restoreDeletedProject(row.id, { actor: req.user });
    res.json({ project });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

trashRouter.delete('/:pid', async (req, res, next) => {
  try {
    const row = guardTrashed(req, res);
    if (!row) return;
    await purgeDeletedProject(row.id, { actor: req.user });
    res.json({ purged: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});
