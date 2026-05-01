/**
 * server/api/assets.js — 上传素材到 project shared workspace
 *
 * POST   /api/projects/:pid/assets             multipart file → 写到 shared/assets/
 * GET    /api/projects/:pid/assets             列 shared/assets/ 下的文件
 * DELETE /api/projects/:pid/assets/:filename   删 shared/assets/<filename>
 *
 * H3 改造：assets 是 project 共享资源（跨 session），落在 shared/assets/。
 * agent 通过 additionalDirectories 跨目录 Read。
 */

import express from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import {
  getSharedDir, ensureProjectWorkspace,
} from '../projects/workspace.js';

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

    await ensureProjectWorkspace(req.params.pid);
    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');

    let filename = sanitizeFilename(req.file.originalname);
    const targetPath = path.join(assetsDir, filename);
    if (await exists(targetPath)) {
      const ts = Date.now().toString(36);
      filename = `${ts}_${filename}`;
    }

    const finalPath = path.join(assetsDir, filename);
    await fs.writeFile(finalPath, req.file.buffer);

    res.status(201).json({
      asset: {
        // path 给 agent Read 用 — 相对 cwd（sessions/<sid>/）走 ../shared/assets/
        // 或者用 SDK additionalDirectories 拿到的绝对路径前缀；前端展示用 name 即可。
        path: `../../shared/assets/${filename}`,
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

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
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
        path: `../../shared/assets/${e.name}`,
        name: e.name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
    assets.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ assets });
  } catch (err) { next(err); }
});

// H4b：删 asset 文件
router.delete('/:pid/assets/:filename', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    if (!getProject(req.params.pid)) return res.status(404).json({ error: 'project not found' });

    const filename = req.params.filename;
    // 严格防 traversal：只允许 sanitize 后产生的字符集
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const filePath = path.join(assetsDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'asset not found' });
      throw err;
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export default router;
