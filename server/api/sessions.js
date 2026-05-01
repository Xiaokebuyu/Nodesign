/**
 * server/api/sessions.js — Session list / read API（薄壳调 SDK）
 *
 * GET /api/projects/:pid/sessions          → SDK listSessions({ dir: workspace })
 * GET /api/projects/:pid/sessions/:sid     → SDK getSessionMessages(sid, { dir: workspace })
 *
 * 不自建 messages 表 —— 全靠 SDK 自带 JSONL 转录（S1 已落 per-project
 * <workspace>/.claude/projects/<encoded>/<sid>.jsonl）。
 *
 * SDK API 读 process.env.CLAUDE_CONFIG_DIR 决定 base 目录（probe 已验），
 * 通过 lib/sdk-session.js withConfigDir 串行化设 env 防多 project 并发互覆。
 */

import express from 'express';
import path from 'path';
import {
  listSessions,
  getSessionMessages,
  forkSession,
  renameSession,
  tagSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { getProjectWorkspace } from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';

const router = express.Router();

router.get('/:pid/sessions', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const wsRoot = getProjectWorkspace(req.params.pid);
    const wsClaudeDir = path.join(wsRoot, '.claude');

    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;

    const sessions = await withConfigDir(wsClaudeDir, () =>
      listSessions({ dir: wsRoot, limit, offset }),
    );
    res.json({ sessions });
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const wsRoot = getProjectWorkspace(req.params.pid);
    const wsClaudeDir = path.join(wsRoot, '.claude');

    // includeSystemMessages 默认 false（前端展示不需要 SDK 内部 system 元消息）；
    // 调用方需要时通过 ?includeSystem=1 打开
    const includeSystemMessages = req.query.includeSystem === '1';

    const messages = await withConfigDir(wsClaudeDir, () =>
      getSessionMessages(req.params.sid, { dir: wsRoot, includeSystemMessages }),
    );
    res.json({ messages });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:pid/sessions/:sid/fork
 *   body: { upToMessageId?, title? }
 *   → { sessionId } 新 fork session id
 *
 * 走 SDK forkSession：复制（或截断到指定 message UUID 后复制）一个新
 * session，可指定标题。NoDesign 用例：从某条历史 message 起 fork 探索
 * 变体（"如果当时不那么改，会怎样"）。
 */
router.post('/:pid/sessions/:sid/fork', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const wsRoot = getProjectWorkspace(req.params.pid);
    const wsClaudeDir = path.join(wsRoot, '.claude');
    const { upToMessageId, title } = req.body || {};

    const result = await withConfigDir(wsClaudeDir, () =>
      forkSession(req.params.sid, { dir: wsRoot, upToMessageId, title }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * PATCH /api/projects/:pid/sessions/:sid
 *   body: { title?, tag? }（tag 传 null 清除，传 string 设置）
 *   → { ok: true }
 */
router.patch('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const wsRoot = getProjectWorkspace(req.params.pid);
    const wsClaudeDir = path.join(wsRoot, '.claude');
    const { title, tag } = req.body || {};

    if (typeof title === 'string') {
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      await withConfigDir(wsClaudeDir, () =>
        renameSession(req.params.sid, title, { dir: wsRoot }),
      );
    }
    if ('tag' in (req.body || {})) {
      if (tag !== null && typeof tag !== 'string') {
        return res.status(400).json({ error: 'tag must be string or null' });
      }
      if (typeof tag === 'string' && tag.length > 50) {
        return res.status(400).json({ error: 'tag too long (max 50)' });
      }
      await withConfigDir(wsClaudeDir, () =>
        tagSession(req.params.sid, tag, { dir: wsRoot }),
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/projects/:pid/sessions/:sid
 *   → 204
 *
 * 删 session JSONL 文件。如果删的是 project.activeSessionId 顺手清空
 * 防止下次 turn resume 找不到。
 */
router.delete('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const wsRoot = getProjectWorkspace(req.params.pid);
    const wsClaudeDir = path.join(wsRoot, '.claude');

    await withConfigDir(wsClaudeDir, () =>
      deleteSession(req.params.sid, { dir: wsRoot }),
    );
    if (project.activeSessionId === req.params.sid) {
      try { setActiveSession(req.params.pid, null); } catch { /* ignore */ }
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
