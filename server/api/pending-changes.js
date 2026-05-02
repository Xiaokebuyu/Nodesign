/**
 * server/api/pending-changes.js — 用户直接编辑 + 评论 buffer（C4）
 *
 * 用户在 canvas 上做的"直接改文本"和"写评论"在前端 push 到这里。下次发 chat
 * 消息时，turn.js 在 composeUserMessage 里 prepend 一个 system 提示告诉 agent
 * "有 N 处变更"，agent 主动调 mcp__nodesign__get_pending_changes 拉详情。
 *
 * 路径：
 *   POST   /api/projects/:pid/sessions/:sid/pending-changes  append item
 *   GET    /api/projects/:pid/sessions/:sid/pending-changes  返 { items, count }
 *   DELETE /api/projects/:pid/sessions/:sid/pending-changes  全清（也接 ?ids=）
 *
 * 文件：<sessionRoot>/pending-changes.json
 *   { items: [{ id, kind, anchor, aiContext?, diff?, text?, ts }] }
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { validateProjectId, getProject } from '../projects/store.js';
import { ensureSessionWorkspace, validateSessionId } from '../projects/workspace.js';

const router = express.Router();

const FILE_NAME = 'pending-changes.json';
const MAX_ITEMS = 200;

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

async function readBuf(sessionRoot) {
  const file = path.join(sessionRoot, FILE_NAME);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return { items: parsed.items, file };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { items: [], file };
}

async function writeBuf(file, items) {
  await fs.writeFile(file, JSON.stringify({ items }, null, 2), 'utf8');
}

router.get('/:pid/sessions/:sid/pending-changes', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const { items } = await readBuf(sessionRoot);
    res.json({ items, count: items.length });
  } catch (err) { next(err); }
});

router.post('/:pid/sessions/:sid/pending-changes', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const { kind, anchor } = body;
    if (kind !== 'edit' && kind !== 'comment') {
      return res.status(400).json({ error: 'kind must be "edit" or "comment"' });
    }
    if (!anchor || typeof anchor !== 'object') {
      return res.status(400).json({ error: 'anchor object required' });
    }
    if (kind === 'edit') {
      const { diff } = body;
      if (!diff || typeof diff !== 'object'
          || typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') {
        return res.status(400).json({ error: 'edit kind requires diff: { oldText, newText }' });
      }
    } else {
      const { text } = body;
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'comment kind requires non-empty text' });
      }
    }

    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const { items, file } = await readBuf(sessionRoot);

    const item = {
      id: randomUUID(),
      kind,
      anchor,
      ...(body.aiContext ? { aiContext: body.aiContext } : {}),
      ...(kind === 'edit' ? { diff: body.diff } : { text: body.text }),
      ts: new Date().toISOString(),
    };
    items.push(item);
    // 上限保护：超 MAX_ITEMS 时砍掉最老的（防 buffer 失控）
    const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
    await writeBuf(file, trimmed);

    res.json({ ok: true, item, count: trimmed.length });
  } catch (err) { next(err); }
});

router.delete('/:pid/sessions/:sid/pending-changes', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const { items, file } = await readBuf(sessionRoot);

    let next;
    const idsParam = req.query?.ids;
    if (idsParam) {
      const ids = String(idsParam).split(',').map(s => s.trim()).filter(Boolean);
      const set = new Set(ids);
      next = items.filter(it => !set.has(it.id));
    } else {
      next = [];
    }
    const removed = items.length - next.length;
    await writeBuf(file, next);
    res.json({ ok: true, removed, count: next.length });
  } catch (err) { next(err); }
});

export default router;

/**
 * Helper for turn.js / agent loop — 同步检查 buffer 是否非空（不加路由）。
 * @returns {Promise<{ count, summary }>}
 *    summary 形如 "用户在过去时段做了 3 处变更（2 编辑 + 1 评论）"
 */
export async function readPendingSummary(sessionRoot) {
  try {
    const { items } = await readBuf(sessionRoot);
    if (items.length === 0) return { count: 0, summary: '' };
    const edits = items.filter(it => it.kind === 'edit').length;
    const comments = items.filter(it => it.kind === 'comment').length;
    const parts = [];
    if (edits > 0) parts.push(`${edits} 编辑`);
    if (comments > 0) parts.push(`${comments} 评论`);
    return {
      count: items.length,
      summary: `用户在过去时段做了 ${items.length} 处变更（${parts.join(' + ')}）`,
    };
  } catch {
    return { count: 0, summary: '' };
  }
}
