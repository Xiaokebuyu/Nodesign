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
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject } from '../projects/store.js';
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

export default router;
