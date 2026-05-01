/**
 * server/api/instruction.js — 项目 Instruction 文件读写
 *
 * Instruction = workspace/.claude/CLAUDE.md。SDK 启用 settingSources:
 * ['project'] 后 agent 进每次 session 自动读到 system prompt。S1 已经
 * 在 ensureProjectWorkspace 写入模板 starter，本阶段加 GET/PUT 让前端
 * "项目背景" tab 直接编辑该文件。
 *
 * GET /api/projects/:pid/instruction
 *   → { content: string, exists: boolean }
 *
 * PUT /api/projects/:pid/instruction
 *   body: { content: string }
 *   → { ok: true }
 *
 * 长度限制 64KB（agent system prompt 不该太长 → token 浪费）。
 * 文件不存在时返回 exists=false，content 用模板内容（fallback 不报错）。
 */

import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { validateProjectId, getProject } from '../projects/store.js';
import { getProjectWorkspace, ensureProjectWorkspace } from '../projects/workspace.js';

const router = express.Router();

const INSTRUCTION_FILE = 'CLAUDE.md';
const INSTRUCTION_MAX_BYTES = 64 * 1024;

router.get('/:pid/instruction', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    // ensureProjectWorkspace 幂等补齐（老 project 第一次进 instruction tab 也能读到）
    await ensureProjectWorkspace(req.params.pid);

    const filePath = path.join(getProjectWorkspace(req.params.pid), '.claude', INSTRUCTION_FILE);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      res.json({ content, exists: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        // ensureProjectWorkspace 应该已经写了，这里 fallback 防万一
        res.json({ content: '', exists: false });
      } else {
        throw err;
      }
    }
  } catch (err) { next(err); }
});

router.put('/:pid/instruction', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be string' });
    }
    if (Buffer.byteLength(content, 'utf8') > INSTRUCTION_MAX_BYTES) {
      return res.status(400).json({ error: `instruction too long (max ${INSTRUCTION_MAX_BYTES} bytes)` });
    }

    await ensureProjectWorkspace(req.params.pid);
    const filePath = path.join(getProjectWorkspace(req.params.pid), '.claude', INSTRUCTION_FILE);
    await fs.writeFile(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
