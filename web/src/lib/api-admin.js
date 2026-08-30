/**
 * lib/api-admin.js — 管理台的接口客户端。
 *
 * 2026-08-17 从 api.js 搬出来。只有 `/admin` 那一个页面用它，跟别的调用方
 * 一行不共享；搬它是因为 api.js 压在行数棘轮上限上 ——「想给胖文件加功能，
 * 先拆出去一块」。
 */

import { jsonRequest } from './api.js';

// ── Admin（仅 admin 可见；后端 adminGuard 兜底）──
export const Admin = {
  /** harness 问题库：auto=工具失败自动记录，agent=report_friction 主动报 */
  issues: ({ status, source, kind } = {}) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (source) qs.set('source', source);
    if (kind) qs.set('kind', kind);
    const q = qs.toString();
    return jsonRequest('GET', `/api/admin/issues${q ? `?${q}` : ''}`);
  },
  setIssueStatus: (id, status) => jsonRequest('PATCH', `/api/admin/issues/${id}`, { status }),
  removeIssue: (id) => jsonRequest('DELETE', `/api/admin/issues/${id}`),
  // 控制台（2026-08-02）：用户 / 邀请码 / 公告，后端早齐了，这里只是接线
  users: () => jsonRequest('GET', '/api/admin/users'),
  patchUser: (id, patch) => jsonRequest('PATCH', `/api/admin/users/${id}`, patch),
  /** 设计 / 演出各自的项目数、回合数、花费（后端已排掉站主自己） */
  modes: () => jsonRequest('GET', '/api/admin/modes'),
  invites: () => jsonRequest('GET', '/api/admin/invites'),
  createInvite: (body) => jsonRequest('POST', '/api/admin/invites', body),
  patchInvite: (code, body) => jsonRequest('PATCH', `/api/admin/invites/${encodeURIComponent(code)}`, body),
  notices: () => jsonRequest('GET', '/api/admin/notices'),
  createNotice: (body) => jsonRequest('POST', '/api/admin/notices', body),
  retireNotice: (id) => jsonRequest('DELETE', `/api/admin/notices/${id}`),
  // 内容外审留证（2026-08-02）：拦截在 turn 闸门，这里只读账
  moderation: ({ userId, limit } = {}) => {
    const qs = new URLSearchParams();
    if (userId) qs.set('userId', userId);
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    return jsonRequest('GET', `/api/admin/moderation${q ? `?${q}` : ''}`);
  },
  removeFlag: (id) => jsonRequest('DELETE', `/api/admin/moderation/${id}`),
};