/**
 * server/api/sessions.js — Session CRUD（H3：session-scoped workspace）
 *
 * GET    /api/projects/:pid/sessions                列项目所有 session（自实现）
 * GET    /api/projects/:pid/sessions/:sid           SDK getSessionMessages
 * POST   /api/projects/:pid/sessions/:sid/fork      SDK forkSession + 复制产物
 * PATCH  /api/projects/:pid/sessions/:sid           SDK rename + tag
 * DELETE /api/projects/:pid/sessions/:sid           SDK deleteSession + 删 session 目录
 *
 * H3 改造：每个 session 独立工作目录 sessions/<sid>/，CLAUDE_CONFIG_DIR
 * per-session（sessions/<sid>/.claude/）。SDK listSessions 按 cwd encoded path
 * 索引 jsonl，跨 session 列要自己 readdir sessions/ 后 per-sid getSessionInfo。
 */

import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import {
  getSessionInfo,
  getSessionMessages,
  forkSession,
  renameSession,
  tagSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { closeQuerySession, hasActiveQuerySession } from '../engine/runs/active-runs.js';
import {
  getProjectWorkspace,
  getSessionWorkspace,
  ensureSessionWorkspace,
  forkSessionWorkspace,
  removeSessionWorkspace,
  validateSessionId,
} from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';

const router = express.Router();

// SDK 内部把 cwd 编码成 ~/.claude/projects/<encoded>/ 子目录路径，
// 算法（grep 自 sdk.mjs）：所有非字母数字字符转 '-'。
function encodeCwdForSDK(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 列指定 project 的所有 session（按 lastModified 倒序）。共享给：
 * 1. GET /api/projects/:pid/sessions（这文件下面的路由）
 * 2. GET /api/sessions/recent（recent.js 跨项目聚合）
 *
 * 后端实现：readdir sessions/ → 对每个 sid 调 SDK getSessionInfo
 * （per-session CLAUDE_CONFIG_DIR）→ filter null → sort by lastModified。
 *
 * @param {string} pid
 * @returns {Promise<object[]>} sessions 数组（每条至少含 sessionId / lastModified；
 *   SDK 还会补 customTitle / summary / firstPrompt / tag 等字段）
 */
export async function listSessionsForProject(pid) {
  const sessionsRoot = path.join(getProjectWorkspace(pid), 'sessions');
  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const sids = entries
    .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name))
    .map(e => e.name);
  const results = await Promise.all(sids.map(async (sid) => {
    const sessionRoot = path.join(sessionsRoot, sid);
    const sessionClaudeDir = path.join(sessionRoot, '.claude');
    try {
      const info = await withConfigDir(sessionClaudeDir, () =>
        getSessionInfo(sid, { dir: sessionRoot }),
      );
      return info || null;
    } catch (err) {
      console.warn(`[sessions list] ${sid.slice(0, 8)} info failed:`, err.message);
      return null;
    }
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
}

// ── List：自实现（readdir sessions/ + per-sid getSessionInfo）──
router.get('/:pid/sessions', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const all = await listSessionsForProject(req.params.pid);

    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : all.length;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const sessions = all.slice(offset, offset + limit);

    res.json({ sessions });
  } catch (err) { next(err); }
});

// ── Read：单 session messages ──
router.get('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const sessionClaudeDir = path.join(sessionRoot, '.claude');

    const includeSystemMessages = req.query.includeSystem === '1';

    const messages = await withConfigDir(sessionClaudeDir, () =>
      getSessionMessages(req.params.sid, {
        dir: sessionRoot,
        includeSystemMessages,
      }),
    );
    res.json({ messages });
  } catch (err) { next(err); }
});

// ── Fork：SDK fork + 复制产物 + mv jsonl 到新 session 子目录 ──
router.post('/:pid/sessions/:sid/fork', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const srcSid = req.params.sid;
    const srcSessionRoot = getSessionWorkspace(req.params.pid, srcSid);
    const srcClaudeDir = path.join(srcSessionRoot, '.claude');
    const { upToMessageId, title } = req.body || {};

    // 1. SDK fork —— 在 src 的 CLAUDE_CONFIG_DIR 下生成新 sid 的 jsonl，
    //    路径 srcClaudeDir/projects/<encoded(srcSessionRoot)>/<newSid>.jsonl
    const result = await withConfigDir(srcClaudeDir, () =>
      forkSession(srcSid, { dir: srcSessionRoot, upToMessageId, title }),
    );
    const newSid = result.sessionId;
    validateSessionId(newSid);

    // 2. cp -r src 产物（canvas/spec/.git）→ sessions/<newSid>/
    await forkSessionWorkspace(req.params.pid, srcSid, newSid);

    // 3. mv 新 jsonl 从 src 的 encoded-cwd 子目录到 new 的 encoded-cwd 子目录
    //    （保持 listSessions(dir=newSessionRoot) 能找到 jsonl）
    const srcEncoded = encodeCwdForSDK(srcSessionRoot);
    const srcJsonl = path.join(srcClaudeDir, 'projects', srcEncoded, `${newSid}.jsonl`);

    const newSessionRoot = getSessionWorkspace(req.params.pid, newSid);
    const newClaudeDir = path.join(newSessionRoot, '.claude');
    const newEncoded = encodeCwdForSDK(newSessionRoot);
    const newJsonlDir = path.join(newClaudeDir, 'projects', newEncoded);
    const newJsonl = path.join(newJsonlDir, `${newSid}.jsonl`);

    await fs.mkdir(newJsonlDir, { recursive: true });
    try {
      await fs.rename(srcJsonl, newJsonl);
    } catch (err) {
      // 如果 SDK 写到的位置跟我们假设的 encoded path 不一致，找一下
      console.warn(`[fork] rename ${srcJsonl} → ${newJsonl} failed (${err.code}); searching alt encoded dir`);
      const altParent = path.join(srcClaudeDir, 'projects');
      const altSubs = await fs.readdir(altParent).catch(() => []);
      for (const sub of altSubs) {
        const candidate = path.join(altParent, sub, `${newSid}.jsonl`);
        try {
          await fs.access(candidate);
          await fs.rename(candidate, newJsonl);
          break;
        } catch { /* continue */ }
      }
    }

    res.json({ sessionId: newSid });
  } catch (err) { next(err); }
});

// ── PATCH：rename / tag ──
router.patch('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const sessionClaudeDir = path.join(sessionRoot, '.claude');
    const { title, tag } = req.body || {};

    if (typeof title === 'string') {
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      await withConfigDir(sessionClaudeDir, () =>
        renameSession(req.params.sid, title, { dir: sessionRoot }),
      );
    }
    if ('tag' in (req.body || {})) {
      if (tag !== null && typeof tag !== 'string') {
        return res.status(400).json({ error: 'tag must be string or null' });
      }
      if (typeof tag === 'string' && tag.length > 50) {
        return res.status(400).json({ error: 'tag too long (max 50)' });
      }
      await withConfigDir(sessionClaudeDir, () =>
        tagSession(req.params.sid, tag, { dir: sessionRoot }),
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Close：终结活跃 query session（streamInput 模式）──
//   POST /api/projects/:pid/sessions/:sid/close
//   关掉 inputQueue → runSession for-await-of 自然退出 → query 进程死。
//   下次 turn 该 sid 起新 runSession（resume 旧 jsonl）。
//   200 { ok: true, wasActive }
router.post('/:pid/sessions/:sid/close', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const wasActive = hasActiveQuerySession(req.params.sid);
    if (wasActive) closeQuerySession(req.params.sid, 'user_close');
    res.json({ ok: true, wasActive });
  } catch (err) { next(err); }
});

// ── DELETE：SDK 删 jsonl + rm session 目录（产物 / git） ──
router.delete('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    validateSessionId(req.params.sid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const sessionClaudeDir = path.join(sessionRoot, '.claude');

    // 1. SDK delete jsonl
    try {
      await withConfigDir(sessionClaudeDir, () =>
        deleteSession(req.params.sid, { dir: sessionRoot }),
      );
    } catch (err) {
      // 如果 jsonl 已经不存在或 SDK 找不到，silent skip — 后面 rm 整个目录兜底
      console.warn(`[delete session] SDK delete failed (${err.message}); proceeding to rm dir`);
    }

    // 2. rm 整个 sessions/<sid>/ 目录（产物 + git + 软链）
    await removeSessionWorkspace(req.params.pid, req.params.sid);

    // 3. 清 active_session_id 如果指向被删的
    if (project.activeSessionId === req.params.sid) {
      try { setActiveSession(req.params.pid, null); } catch { /* ignore */ }
    }

    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
