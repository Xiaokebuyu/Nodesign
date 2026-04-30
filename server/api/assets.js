/**
 * server/api/assets.js — 上传素材到 project workspace
 *
 * POST /api/projects/:pid/assets    multipart file → 写到 workspace/assets/
 * GET  /api/projects/:pid/assets    列 workspace/assets/ 下的文件
 *
 * 16MB 单文件上限；冲突文件名加时间戳前缀防覆盖。
 *
 * 注：文件不进 git 历史（assets/ 由 .gitignore 排除？目前没排除——
 * agent 改 canvas.html 时 assets 也会被一起 commit。这是设计决策——
 * 用户如果回退到旧 commit，希望对应的素材也回去。）
 */

import express from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import { getProjectWorkspace, ensureProjectWorkspace } from '../projects/workspace.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),  // 先收到内存再写磁盘（方便 sanitize 文件名）
  limits: { fileSize: 16 * 1024 * 1024 },
});

function sanitizeFilename(name) {
  // 只保留 [A-Za-z0-9._-]，替换其它 → '_'。最长 80 字符。
  return (name || 'unnamed')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80);
}

router.post('/:pid/assets', upload.single('file'), async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });
    if (!req.file) return res.status(400).json({ error: 'no file (field name: file)' });

    const wsRoot = await ensureProjectWorkspace(req.params.pid);
    const assetsDir = path.join(wsRoot, 'assets');

    let filename = sanitizeFilename(req.file.originalname);
    const targetPath = path.join(assetsDir, filename);
    if (await exists(targetPath)) {
      // 冲突：加时间戳前缀
      const ts = Date.now().toString(36);
      filename = `${ts}_${filename}`;
    }

    const finalPath = path.join(assetsDir, filename);
    await fs.writeFile(finalPath, req.file.buffer);

    res.status(201).json({
      asset: {
        path: `./assets/${filename}`,
        name: filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:pid/assets', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const wsRoot = getProjectWorkspace(req.params.pid);
    const assetsDir = path.join(wsRoot, 'assets');
    let entries;
    try {
      entries = await fs.readdir(assetsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ assets: [] });
      throw err;
    }
    const assets = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const stat = await fs.stat(path.join(assetsDir, e.name));
      assets.push({
        path: `./assets/${e.name}`,
        name: e.name,
        size: stat.size,
      });
    }
    assets.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ assets });
  } catch (err) { next(err); }
});

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export default router;
