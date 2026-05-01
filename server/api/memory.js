/**
 * server/api/memory.js — 项目级 agent memory 读写（H4b）
 *
 * 数据落在 shared/.claude/agent-memory/<agentType>/<file>，agent 用 SDK
 * memory 机制（loop.js 启用 settingSources: ['project'] 后软链让 agent
 * 看到 shared 路径）按需写。本文件给前端 MemoryCard 展示 + 用户偶尔覆盖。
 *
 * 路径：
 *   shared/.claude/agent-memory/                   ← 顶级（无 agentType）
 *     ├── memory.md                                ← 默认（main agent）
 *     ├── <agentType>/                             ← 子 agent（vision-checker / 等）
 *     │   └── memory.md
 *
 * 简化决策：
 *   - 一个 agentType 一个 memory 概要（concat 子文件作内容）
 *   - GET 返回所有 agentType 概要列表 + 每个的预览
 *   - GET /:agentType 返回该 agent 的全文（concat 多文件）
 *   - PUT /:agentType 覆盖 memory.md（默认文件名）
 *   - DELETE /:agentType 删整个 agent 子目录
 *
 * 长度上限 64KB（agent system prompt 不该太长）
 */

import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { validateProjectId, getProject } from '../projects/store.js';
import { getSharedDir, ensureProjectWorkspace } from '../projects/workspace.js';

const router = express.Router();

const MEMORY_FILE = 'memory.md';
const MEMORY_MAX_BYTES = 64 * 1024;
const AGENT_TYPE_RE = /^[A-Za-z0-9._-]+$/;

function memoryRoot(pid) {
  return path.join(getSharedDir(pid), '.claude', 'agent-memory');
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readDirectoryConcat(dir) {
  let out = '';
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile()) continue;
      try {
        const content = await fs.readFile(path.join(dir, e.name), 'utf8');
        if (out) out += '\n\n';
        out += content;
      } catch { /* skip unreadable */ }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return out;
}

// ── GET：列项目所有 agent 的 memory 概要 ──
router.get('/:pid/memory', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    await ensureProjectWorkspace(req.params.pid);
    const root = memoryRoot(req.params.pid);

    // 默认（顶层 memory.md，main agent 用）
    const out = [];
    const topMemoryFile = path.join(root, MEMORY_FILE);
    if (await fileExists(topMemoryFile)) {
      const content = await fs.readFile(topMemoryFile, 'utf8');
      out.push({
        agentType: null,  // 顶层 = main agent / shared
        size: Buffer.byteLength(content, 'utf8'),
        preview: content.slice(0, 200),
      });
    }

    // 子目录 = 各 agentType
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!AGENT_TYPE_RE.test(e.name)) continue;
      const subDir = path.join(root, e.name);
      const content = await readDirectoryConcat(subDir);
      if (!content) continue;
      out.push({
        agentType: e.name,
        size: Buffer.byteLength(content, 'utf8'),
        preview: content.slice(0, 200),
      });
    }

    res.json({ memory: out });
  } catch (err) { next(err); }
});

// ── GET /:agentType：读单个 agent 全文 ──
router.get('/:pid/memory/:agentType', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const agentType = req.params.agentType;
    if (agentType !== '_root' && !AGENT_TYPE_RE.test(agentType)) {
      return res.status(400).json({ error: 'invalid agentType' });
    }

    await ensureProjectWorkspace(req.params.pid);
    const root = memoryRoot(req.params.pid);
    const target = agentType === '_root'
      ? root
      : path.join(root, agentType);

    let content = '';
    if (agentType === '_root') {
      const top = path.join(root, MEMORY_FILE);
      if (await fileExists(top)) content = await fs.readFile(top, 'utf8');
    } else {
      content = await readDirectoryConcat(target);
    }

    res.json({ content, exists: !!content });
  } catch (err) { next(err); }
});

// ── PUT /:agentType：覆盖 memory.md ──
router.put('/:pid/memory/:agentType', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const agentType = req.params.agentType;
    if (agentType !== '_root' && !AGENT_TYPE_RE.test(agentType)) {
      return res.status(400).json({ error: 'invalid agentType' });
    }

    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be string' });
    }
    if (Buffer.byteLength(content, 'utf8') > MEMORY_MAX_BYTES) {
      return res.status(400).json({ error: `memory too long (max ${MEMORY_MAX_BYTES} bytes)` });
    }

    await ensureProjectWorkspace(req.params.pid);
    const root = memoryRoot(req.params.pid);
    const targetDir = agentType === '_root' ? root : path.join(root, agentType);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, MEMORY_FILE), content, 'utf8');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /:agentType：删整个 agent 子目录 / 顶层文件 ──
router.delete('/:pid/memory/:agentType', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const agentType = req.params.agentType;
    if (agentType !== '_root' && !AGENT_TYPE_RE.test(agentType)) {
      return res.status(400).json({ error: 'invalid agentType' });
    }

    const root = memoryRoot(req.params.pid);
    if (agentType === '_root') {
      const top = path.join(root, MEMORY_FILE);
      try { await fs.unlink(top); } catch { /* OK if not exist */ }
    } else {
      const sub = path.join(root, agentType);
      try { await fs.rm(sub, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
