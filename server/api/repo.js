/**
 * server/api/repo.js — 仓库卡的接口（2026-09-08 存量仓库道·第二段）。只在本地版挂载（index.js）。
 *
 *   GET /api/projects/:pid/repo                     分支 / 上次提交 / 改动计数；不是仓库项目 → 404
 *   GET /api/projects/:pid/repo/tree?path=<rel>     列一层，每条带 git 状态
 *   GET /api/projects/:pid/repo/file?path=<rel>     文本内容给代码阅读器（512KB 封顶）
 *
 * 全部只读。仓库卡是一扇窗，不是一双手。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { repoSummary, repoTree, repoFile } from '../projects/repo.js';

const router = express.Router();

function fail(res, err) {
  if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

router.get('/:pid/repo', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const summary = await repoSummary(req.params.pid);
    if (!summary) return res.status(404).json({ error: '这个项目没有仓库卡', code: 'NOT_REPO_PROJECT' });
    res.json(summary);
  } catch (err) { next(err); }
});

router.get('/:pid/repo/tree', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json(await repoTree(req.params.pid, typeof req.query.path === 'string' ? req.query.path : ''));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.get('/:pid/repo/file', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json(await repoFile(req.params.pid, typeof req.query.path === 'string' ? req.query.path : ''));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

export default router;
