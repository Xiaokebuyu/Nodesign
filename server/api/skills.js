/**
 * server/api/skills.js — Skill 列表
 *
 * GET /api/skills                    列全局 skills（server/engine/skills/）
 * GET /api/skills?projectId=xxx      列全局 + project local（.claude/skills/）
 *
 * P0 只读不写。skill 上传留到 P0+。
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { listSkills as listGlobalSkills } from '../engine/agent/skill.js';
import { validateProjectId, getProject } from '../projects/store.js';
import { getProjectWorkspace } from '../projects/workspace.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const global = await listGlobalSkills();
    let projectLocal = [];

    const pid = req.query.projectId;
    if (pid && typeof pid === 'string') {
      try {
        validateProjectId(pid);
        if (getProject(pid)) {
          projectLocal = await listProjectLocalSkills(pid);
        }
      } catch { /* invalid pid → 静默忽略 */ }
    }

    res.json({
      global: global.map((s) => ({ ...s, scope: 'global' })),
      projectLocal: projectLocal.map((s) => ({ ...s, scope: 'project' })),
    });
  } catch (err) { next(err); }
});

async function listProjectLocalSkills(pid) {
  const wsRoot = getProjectWorkspace(pid);
  const skillsDir = path.join(wsRoot, '.claude', 'skills');
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(skillsDir, e.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile, 'utf8');
      const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
      const frontmatter = {};
      if (fmMatch) {
        for (const line of fmMatch[1].split('\n')) {
          const m = /^([a-zA-Z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
          if (m) frontmatter[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
      }
      out.push({
        id: e.name,
        name: frontmatter.name || e.name,
        version: frontmatter.version || '0.0.0',
        description: frontmatter.description || '',
      });
    } catch { /* skip broken skill */ }
  }
  return out;
}

export default router;
