/**
 * web/src/lib/api-trash.js — 项目回收站（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 删除项目 = 进回收站（DELETE /api/projects/:pid 仍在 api.js 的 Projects.remove），
 * 这里是回收站自己的几条：列表、恢复、立即永久删除、管理员查审计。
 * 单独成文件：api.js 顶在行数棘轮上限，回收站跟项目 CRUD 也不是同一件事。
 */
import { jsonRequest } from './api.js';

export const Trash = {
  /** → { retentionDays, projects: [{ id, name, mode, deletedAt, purgeAfter, publishedSites, … }] }；all 仅管理员有效 */
  list: ({ all = false } = {}) => jsonRequest('GET', `/api/projects/trash${all ? '?all=1' : ''}`),
  /** → { project } */
  restore: (pid) => jsonRequest('POST', `/api/projects/trash/${encodeURIComponent(pid)}/restore`),
  /** 立即永久删除，不可恢复 → { purged: true } */
  purge: (pid) => jsonRequest('DELETE', `/api/projects/trash/${encodeURIComponent(pid)}`),
  /** 删除 / 恢复 / 永久删除的审计（仅管理员）→ { events } */
  log: ({ projectId, limit } = {}) => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (limit) q.set('limit', String(limit));
    const tail = q.toString();
    return jsonRequest('GET', `/api/projects/trash/log${tail ? `?${tail}` : ''}`);
  },
};
