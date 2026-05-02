/**
 * server/api/recent.js — 跨项目最近 session 聚合接口
 *
 * GET /api/sessions/recent?limit=20&kind=quick
 *   → { sessions: [{
 *         projectId, projectName, projectKind,
 *         sessionId, customTitle, summary, firstPrompt, lastModified, tag
 *       }] }
 *
 * 用途：
 *   - Home 页「最近闪聊」list（kind=quick 过滤）
 *   - 未来 Home 全局 session 索引（不过滤）
 *
 * 实现：listProjects({ kind? }) → 对每个 project 调 listSessionsForProject →
 * merge → 按 lastModified desc → slice(limit)。
 *
 * 性能：N 个 project × Promise.all 内部并行（readdir + getSessionInfo）。
 * 当前预期项目规模 < 30，足够；如未来要扩，加 in-memory cache 或维护 view。
 */

import express from 'express';
import { listProjects } from '../projects/store.js';
import { listSessionsForProject } from './sessions.js';

const router = express.Router();

const KIND_VALUES = new Set(['project', 'quick']);

router.get('/sessions/recent', async (req, res, next) => {
  try {
    const limit = req.query.limit
      ? Math.min(Math.max(Number(req.query.limit), 1), 100)
      : 20;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (kind && !KIND_VALUES.has(kind)) {
      return res.status(400).json({ error: `kind must be project|quick (got ${kind})` });
    }

    const projects = listProjects({ kind, limit: 200 });

    // 并行拿每个 project 的 sessions
    const perProject = await Promise.all(projects.map(async (p) => {
      try {
        const sessions = await listSessionsForProject(p.id);
        return sessions.map(s => ({
          projectId: p.id,
          projectName: p.name,
          projectKind: p.kind,
          sessionId: s.sessionId,
          customTitle: s.customTitle || null,
          summary: s.summary || null,
          firstPrompt: s.firstPrompt || null,
          lastModified: s.lastModified || 0,
          tag: s.tag || null,
        }));
      } catch (err) {
        console.warn(`[sessions/recent] ${p.id} list failed:`, err.message);
        return [];
      }
    }));

    const merged = perProject.flat()
      .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
      .slice(0, limit);

    res.json({ sessions: merged });
  } catch (err) { next(err); }
});

export default router;
