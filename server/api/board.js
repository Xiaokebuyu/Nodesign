/**
 * server/api/board.js — 工作台画布布局持久化（2026-07-27 分区版）
 *
 * GET   /api/projects/:pid/board  → shared/board.json（无则返回默认空布局）
 * PATCH /api/projects/:pid/board  → diff 合并写（前端拖拽/建区只发脏条目；null=删）
 * PUT   /api/projects/:pid/board  → 全量替换（保留给 reset 场景）
 *
 * 读写统一走 server/projects/board-store.js（带 per-project 写锁，
 * 与 agent 侧 pin_to_board 工具共享，互不覆盖）。
 */

import express from 'express';
import { listRoleNames } from '../engine/agent/role-card.js';
import { getWorkspaceRoot } from '../projects/workspace.js';
import { validateProjectId, getProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import { readBoard, replaceBoard, patchBoard } from '../projects/board-store.js';
import { commitStaging, removeByTag } from '../projects/board-tags.js';
import { noteBoardDirty } from '../lib/board-dirty.js';
import { setViewpoint, getViewpoint } from '../projects/viewpoint-store.js';
import { exportGraph, exportGraphZip } from '../lib/board-graph-export.js';
import { getSharedDir } from '../projects/workspace.js';

const router = express.Router();

function guard(req, res) {
  // pid 校验 + 存在性 + 归属（2026-07-30 多用户）统一走 guardProject
  return !!guardProject(req, res);
}

router.get('/:pid/board', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    // roles 是**派生态**：每次从 .claude/agents/ 现读，不落 board.json ——
    // 板上存的署名是 slug（权威），展示名住在角色文件里（模型可改），两者不能混成一份数据。
    // 前端只拿它把 slug 渲染得好看，任何判断仍按 slug 走。
    let roles = {};
    try { roles = Object.fromEntries(await listRoleNames(getWorkspaceRoot(req.params.pid))); } catch { /* 没有角色就是空表 */ }
    res.json({ board: await readBoard(req.params.pid), roles });
  } catch (err) { next(err); }
});

router.patch('/:pid/board', express.json({ limit: '600kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const patch = req.body?.patch;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch required' });
    // 板上动静（2026-08-29 刀 4）：HTTP PATCH 就是用户的手。**位置真变了才算动静**
    // —— 前端的尺寸回写（useMeasuredSize）也走这条路，只有 w/h 变化不该吵 agent。
    let prev = null;
    if (patch.objects && typeof patch.objects === 'object') {
      try { prev = await readBoard(req.params.pid); } catch { /* 记不上不挡写 */ }
    }
    const board = await patchBoard(req.params.pid, patch);
    if (prev) {
      const events = [];
      for (const [id, o] of Object.entries(patch.objects)) {
        const was = prev.objects?.[id];
        if (o === null) { if (was) events.push({ kind: 'removed', id }); continue; }
        const now = board.objects?.[id];
        if (!was || !now) continue;
        if (Math.round(was.x) !== Math.round(now.x) || Math.round(was.y) !== Math.round(now.y)) {
          events.push({ kind: 'moved', id });
        }
      }
      if (events.length) noteBoardDirty(req.params.pid, events);
    }
    res.json({ ok: true, board });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.put('/:pid/board', express.json({ limit: '600kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const body = req.body?.board;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'board required' });
    const board = await replaceBoard(req.params.pid, body);
    res.json({ ok: true, board });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * 用户视点上报（2026-08-23 黑板）：前端节流 POST，服务端只留最近一份。
 * 不广播、不落盘；失败也不该打扰用户（前端 fire-and-forget）。
 */
router.post('/:pid/viewpoint', express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const v = setViewpoint(req.params.pid, req.body?.viewpoint, req.user?.id || null);
    res.json({ ok: !!v });
  } catch (err) { next(err); }
});

/** 读最近一份视点（排障用：看看服务端眼里"用户在看哪"；agent 走 read_user_view） */
router.get('/:pid/viewpoint', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    res.json({ viewpoint: getViewpoint(req.params.pid) });
  } catch (err) { next(err); }
});

/** 草稿落定（用户也可以按组落定：黑板上 agent 的草稿半透明，点一下变实） */
router.post('/:pid/board/commit', express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const tag = typeof req.body?.tag === 'string' ? req.body.tag : null;
    const { board, committed } = await commitStaging(req.params.pid, { tag });
    res.json({ ok: true, committed, board });
  } catch (err) { next(err); }
});

/** 黑板擦：按 #tag 整组删（只删画布原生物件与线；产物卡只摘标签） */
router.post('/:pid/board/erase', express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const tag = typeof req.body?.tag === 'string' ? req.body.tag : '';
    if (!tag) return res.status(400).json({ error: 'tag required' });
    const { board, removed } = await removeByTag(req.params.pid, tag);
    if (removed) noteBoardDirty(req.params.pid, [{ kind: 'erased', id: tag }]);
    res.json({ ok: true, removed, board });
  } catch (err) { next(err); }
});

/**
 * 连接图导出（2026-08-23 黑板）：?format=json|mermaid|svg&tag=&layer=
 * 真相是 board.json，这里只派生。download=1 时带附件头。
 */
router.get('/:pid/board/graph', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const format = String(req.query.format || 'json');
    const tag = typeof req.query.tag === 'string' && req.query.tag ? req.query.tag.slice(0, 40) : null;
    const layer = typeof req.query.layer === 'string' ? req.query.layer.slice(0, 300) : '';
    const board = await readBoard(req.params.pid);
    if (format === 'zip') {
      const projectName = getProject(req.params.pid)?.name || '画布';
      const { zip } = await exportGraphZip(board, { workspaceRoot: getSharedDir(req.params.pid), tag, layer, projectName });
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`board${tag ? `-${tag}` : ''}.zip`)}`);
      return res.send(buf);
    }
    const { mime, body } = exportGraph(board, { format, tag, layer });
    res.setHeader('Content-Type', mime);
    if (req.query.download) {
      const ext = format === 'mermaid' ? 'mmd' : format;
      const name = `board${tag ? `-${tag}` : ''}.${ext}`;
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    res.send(body);
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

export default router;
