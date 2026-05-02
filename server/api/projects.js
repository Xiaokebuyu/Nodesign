/**
 * server/api/projects.js — Project CRUD
 *
 * GET    /api/projects              列项目（按 updated_at 倒序）
 * POST   /api/projects              { name, skillId?, description? } → 创建 + ensureProjectWorkspace
 * GET    /api/projects/:pid         单项目
 * PATCH  /api/projects/:pid         { name?, skillId?, description? } 部分更新
 * DELETE /api/projects/:pid         删项目 + workspace + 关联 runs
 *
 * description: 可选，<= 2000 字符。仅 NoDesign 后端/前端 UI 用，agent 不感知
 * （agent 看的是项目级 instruction = workspace/.claude/CLAUDE.md）。
 */

import express from 'express';
import {
  listProjects, getProject, createProject, updateProject, deleteProject,
  validateProjectId, listRunsForProject,
} from '../projects/store.js';
import { ensureProjectWorkspace, removeProjectWorkspace } from '../projects/workspace.js';
import { disposeProjectBus } from '../ws/broker.js';

const router = express.Router();

const KIND_VALUES = new Set(['project', 'quick']);

router.get('/', (req, res, next) => {
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (kind && !KIND_VALUES.has(kind)) {
      return res.status(400).json({ error: `kind must be project|quick (got ${kind})` });
    }
    res.json({ projects: listProjects({ kind }) });
  } catch (err) { next(err); }
});

const DESCRIPTION_MAX = 2000;

router.post('/', async (req, res, next) => {
  try {
    const { name, skillId, description, kind } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (description != null && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be string' });
    }
    if (typeof description === 'string' && description.length > DESCRIPTION_MAX) {
      return res.status(400).json({ error: `description too long (max ${DESCRIPTION_MAX})` });
    }
    if (kind != null && !KIND_VALUES.has(kind)) {
      return res.status(400).json({ error: `kind must be project|quick (got ${kind})` });
    }
    const project = createProject({ name, skillId, description, kind });
    await ensureProjectWorkspace(project.id);
    res.status(201).json({ project });
  } catch (err) { next(err); }
});

router.get('/:pid', (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ project });
  } catch (err) { next(err); }
});

router.patch('/:pid', (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const patch = {};
    if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
    if (typeof req.body?.skillId === 'string') patch.skillId = req.body.skillId;
    if ('description' in (req.body || {})) {
      const d = req.body.description;
      if (d != null && typeof d !== 'string') {
        return res.status(400).json({ error: 'description must be string' });
      }
      if (typeof d === 'string' && d.length > DESCRIPTION_MAX) {
        return res.status(400).json({ error: `description too long (max ${DESCRIPTION_MAX})` });
      }
      patch.description = (typeof d === 'string' && d.trim()) ? d.trim() : null;
    }
    if ('kind' in (req.body || {})) {
      if (!KIND_VALUES.has(req.body.kind)) {
        return res.status(400).json({ error: `kind must be project|quick (got ${req.body.kind})` });
      }
      patch.kind = req.body.kind;
    }
    const updated = updateProject(req.params.pid, patch);
    res.json({ project: updated });
  } catch (err) { next(err); }
});

router.delete('/:pid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    // 级联：先清 workspace 文件，再删 DB row（DB row 删了找不到，先文件后 DB 顺序保险）
    try { await removeProjectWorkspace(req.params.pid); } catch (err) {
      console.warn(`[projects] removeWorkspace failed for ${req.params.pid}:`, err.message);
    }
    // 关联 runs：标记为 cancelled? 或直接 delete? MVP 直接 delete 关联 runs 行
    const runs = listRunsForProject(req.params.pid);
    if (runs.length) {
      const { default: db } = await import('../engine/runs/store.js');
      const stmt = db.prepare('DELETE FROM runs WHERE id = ?');
      for (const r of runs) stmt.run(r.id);
    }
    deleteProject(req.params.pid);
    disposeProjectBus(req.params.pid);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
