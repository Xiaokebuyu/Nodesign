/**
 * server/api/canvas.js — Canvas + Spec read/write/history/revert（H3：session-scoped）
 *
 * 路径全加 sid（H3 改造）：
 *   GET    /api/projects/:pid/sessions/:sid/canvas              → text/html
 *   PUT    /api/projects/:pid/sessions/:sid/canvas              { html, source? }
 *   GET    /api/projects/:pid/sessions/:sid/canvas/history      git log
 *   POST   /api/projects/:pid/sessions/:sid/canvas/revert       { commit }
 *   POST   /api/projects/:pid/sessions/:sid/canvas/undo
 *   GET    /api/projects/:pid/sessions/:sid/spec                spec.json（agent 私域档案）
 *
 * 文件实际位置：
 *   <project_workspace>/sessions/<sid>/canvas.html
 *   <project_workspace>/sessions/<sid>/spec.json
 *   <project_workspace>/sessions/<sid>/.git/                  （per-session history）
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import {
  getSessionWorkspace, ensureSessionWorkspace, validateSessionId,
  commitWorkspace, listHistory, revertWorkspace,
} from '../projects/workspace.js';

const router = express.Router();

const MAX_HTML_BYTES = 8 * 1024 * 1024; // 8MB

function guard(req, res) {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
  } catch (err) {
    res.status(400).json({ error: err.message || 'invalid pid/sid' });
    return null;
  }
  const project = getProject(req.params.pid);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

router.get('/:pid/sessions/:sid/canvas', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    try {
      const content = await fs.readFile(file, 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 还没生成（session 刚建，agent 没跑过）—— 占位 HTML
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(EMPTY_CANVAS_HTML);
      } else {
        throw err;
      }
    }
  } catch (err) { next(err); }
});

router.put('/:pid/sessions/:sid/canvas', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const { html, source = 'user' } = req.body || {};
    if (typeof html !== 'string' || html.length === 0) {
      return res.status(400).json({ error: 'html string required' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      return res.status(413).json({ error: 'html too large (>8MB)' });
    }

    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    await fs.writeFile(file, html, 'utf8');

    const ts = new Date().toISOString();
    const commit = await commitWorkspace(
      req.params.pid, req.params.sid,
      `${source}-edit: ${ts}`,
      { author: source === 'agent' ? 'agent' : 'user' },
    );
    res.json({ ok: true, commit });
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/canvas/history', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await listHistory(req.params.pid, req.params.sid, { limit });
    res.json({ entries });
  } catch (err) { next(err); }
});

router.post('/:pid/sessions/:sid/canvas/revert', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const { commit } = req.body || {};
    if (!commit || typeof commit !== 'string') {
      return res.status(400).json({ error: 'commit hash required' });
    }
    const newCommit = await revertWorkspace(req.params.pid, req.params.sid, commit);
    res.json({ ok: true, commit: newCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/:pid/sessions/:sid/canvas/undo', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const entries = await listHistory(req.params.pid, req.params.sid, { limit: 5 });
    if (!entries || entries.length < 2) {
      return res.status(400).json({
        error: 'no previous version to undo to',
        code: 'NO_PREV_COMMIT',
      });
    }
    const prevCommit = entries[1].commit || entries[1].hash || entries[1].sha;
    if (!prevCommit) {
      return res.status(500).json({ error: 'history entry missing commit hash' });
    }
    const newCommit = await revertWorkspace(req.params.pid, req.params.sid, prevCommit);
    res.json({ ok: true, commit: newCommit, revertedTo: prevCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * GET /:pid/sessions/:sid/spec —— 读 sessions/<sid>/spec.json（agent 私域档案）
 *
 * 不存在或解析失败时返回 {} —— 让前端不会因 spec 缺失崩。
 * 这是只读 endpoint —— spec.json 完全由 agent 维护。
 */
router.get('/:pid/sessions/:sid/spec', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'spec.json');
    try {
      const raw = await fs.readFile(file, 'utf8');
      let spec = {};
      try { spec = JSON.parse(raw); } catch { spec = {}; }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) spec = {};
      res.json({ spec });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ spec: {} });
      throw err;
    }
  } catch (err) { next(err); }
});

const EMPTY_CANVAS_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>NoDesign canvas</title>
<style>html,body{margin:0;height:100%;font-family:system-ui;background:#F9F8F6}
.placeholder{display:flex;align-items:center;justify-content:center;height:100%;
color:#3a2a18aa;font-size:14px;letter-spacing:.02em}</style></head>
<body><div class="placeholder">canvas.html 还没生成 · 等 agent 跑一次 turn</div></body></html>
`;

export default router;
