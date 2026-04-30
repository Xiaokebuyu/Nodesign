/**
 * server/api/canvas.js — Canvas (canvas.html) read/write/history/revert
 *
 * GET    /api/projects/:pid/canvas              stream canvas.html（text/html）
 * PUT    /api/projects/:pid/canvas              { html, source? } 写文件 + git commit
 * GET    /api/projects/:pid/canvas/history      git log 列 entries
 * POST   /api/projects/:pid/canvas/revert       { commit } git checkout 那个 commit
 *
 * source 字段（可选）："user"（默认）/ "agent"（agent 工具回写）/ "revert"。
 * 进入 git commit 消息以便 history 可读。
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import {
  getProjectWorkspace, commitWorkspace, listHistory, revertWorkspace,
} from '../projects/workspace.js';

const router = express.Router();

const MAX_HTML_BYTES = 8 * 1024 * 1024; // 8MB

function projectGuard(req, res) {
  try {
    validateProjectId(req.params.pid);
  } catch {
    res.status(400).json({ error: 'invalid pid' });
    return null;
  }
  const project = getProject(req.params.pid);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

router.get('/:pid/canvas', async (req, res, next) => {
  try {
    if (!projectGuard(req, res)) return;
    const wsRoot = getProjectWorkspace(req.params.pid);
    const file = path.join(wsRoot, 'canvas.html');
    try {
      const content = await fs.readFile(file, 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // canvas 还没存在（刚建项目，agent 没跑过）— 返一个空白占位 HTML
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(EMPTY_CANVAS_HTML);
      } else {
        throw err;
      }
    }
  } catch (err) { next(err); }
});

router.put('/:pid/canvas', async (req, res, next) => {
  try {
    if (!projectGuard(req, res)) return;
    const { html, source = 'user' } = req.body || {};
    if (typeof html !== 'string' || html.length === 0) {
      return res.status(400).json({ error: 'html string required' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      return res.status(413).json({ error: 'html too large (>8MB)' });
    }

    const wsRoot = getProjectWorkspace(req.params.pid);
    const file = path.join(wsRoot, 'canvas.html');
    await fs.writeFile(file, html, 'utf8');

    const ts = new Date().toISOString();
    const commit = await commitWorkspace(
      req.params.pid,
      `${source}-edit: ${ts}`,
      { author: source === 'agent' ? 'agent' : 'user' },
    );
    res.json({ ok: true, commit });
  } catch (err) { next(err); }
});

router.get('/:pid/canvas/history', async (req, res, next) => {
  try {
    if (!projectGuard(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await listHistory(req.params.pid, { limit });
    res.json({ entries });
  } catch (err) { next(err); }
});

router.post('/:pid/canvas/revert', async (req, res, next) => {
  try {
    if (!projectGuard(req, res)) return;
    const { commit } = req.body || {};
    if (!commit || typeof commit !== 'string') {
      return res.status(400).json({ error: 'commit hash required' });
    }
    const newCommit = await revertWorkspace(req.params.pid, commit);
    res.json({ ok: true, commit: newCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * POST /:pid/canvas/undo —— 简版"撤销到上一个版本"
 *
 * 前端 UndoButton 直接点 → 自动取倒数第二个 commit checkout 到工作区。
 * 用户不必手动选 commit hash（complex 交互留给 history modal）。
 *
 * 双轨设计的 git 端：跨 session 长期持久。
 * SDK rewindFiles 端（per-query 细粒度）留 P0+ stage 2 接通——需要在
 * loop.js 把活跃 query 实例存到 activeQueries Map，这次先做最小可用版。
 */
router.post('/:pid/canvas/undo', async (req, res, next) => {
  try {
    if (!projectGuard(req, res)) return;
    const entries = await listHistory(req.params.pid, { limit: 5 });
    if (!entries || entries.length < 2) {
      return res.status(400).json({
        error: 'no previous version to undo to',
        code: 'NO_PREV_COMMIT',
      });
    }
    // entries[0] 是当前 HEAD，entries[1] 是上一版（按 git log 时序，最新在前）
    const prevCommit = entries[1].commit || entries[1].hash || entries[1].sha;
    if (!prevCommit) {
      return res.status(500).json({ error: 'history entry missing commit hash' });
    }
    const newCommit = await revertWorkspace(req.params.pid, prevCommit);
    res.json({ ok: true, commit: newCommit, revertedTo: prevCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

const EMPTY_CANVAS_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>NoDesign canvas</title>
<style>html,body{margin:0;height:100%;font-family:system-ui;background:#F9F8F6}
.placeholder{display:flex;align-items:center;justify-content:center;height:100%;
color:#3a2a18aa;font-size:14px;letter-spacing:.02em}</style></head>
<body><div class="placeholder">canvas.html 还没生成 · 等 agent 跑一次 turn</div></body></html>
`;

export default router;
