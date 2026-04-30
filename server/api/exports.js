/**
 * server/api/exports.js — 用户主动导出 endpoints
 *
 * GET /api/projects/:pid/exports/html       stream canvas.html (text/html, attachment)
 * GET /api/projects/:pid/exports/pdf        playwright print → PDF stream
 * GET /api/projects/:pid/exports/handoff    JSZip 打包工程交付 zip
 *
 * 注：
 *  - PDF 依赖 playwright chromium：首次需要 `npx playwright install chromium`
 *  - 每次 PDF 导出 spawn headless chrome（~1-2s 启动延迟）；P0+ 上 pool
 *  - PPTX 留 P0+，本 commit 不实现
 *  - agent export 工具（agent 自己调）也留 P0+，需要给 agent 装 SKILL.md 提示
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { validateProjectId, getProject } from '../projects/store.js';
import { getProjectWorkspace } from '../projects/workspace.js';
import { listRunsForProject } from '../projects/store.js';

const router = express.Router();

function projectGuard(req, res) {
  try {
    validateProjectId(req.params.pid);
  } catch {
    res.status(400).json({ error: 'invalid pid' });
    return null;
  }
  const project = getProject(req.params.pid);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return project;
}

function safeFilename(name) {
  return (name || 'design').replace(/[^A-Za-z0-9._一-龥-]/g, '_').slice(0, 60);
}

// ── 已生成的交付包列表 ──
// agent 调 mcp__nodesign__export_handoff 写到 workspace/exports/handoff-<ts>.zip。
// 前端通过此 endpoint 列出供用户下载（不只是 toast 显示路径）。
router.get('/:pid/exports', async (req, res, next) => {
  try {
    const project = projectGuard(req, res);
    if (!project) return;
    const wsRoot = getProjectWorkspace(req.params.pid);
    const exportsDir = path.join(wsRoot, 'exports');

    let entries;
    try {
      entries = await fs.readdir(exportsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ files: [] });
      throw err;
    }

    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const stat = await fs.stat(path.join(exportsDir, e.name));
        files.push({
          name: e.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch { /* skip unreadable */ }
    }
    // 最新在前
    files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ files });
  } catch (err) { next(err); }
});

// 单文件下载（流式）
router.get('/:pid/exports/file/:filename', async (req, res, next) => {
  try {
    const project = projectGuard(req, res);
    if (!project) return;
    const wsRoot = getProjectWorkspace(req.params.pid);

    // 安全：只允许 [a-zA-Z0-9._-] 文件名，防 path traversal
    const filename = req.params.filename;
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const filePath = path.join(wsRoot, 'exports', filename);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'file not found' });
    }

    const ext = filename.toLowerCase().split('.').pop();
    const mime = ext === 'zip' ? 'application/zip'
      : ext === 'pdf' ? 'application/pdf'
      : ext === 'html' ? 'text/html; charset=utf-8'
      : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const buf = await fs.readFile(filePath);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) { next(err); }
});

// ── HTML ──
router.get('/:pid/exports/html', async (req, res, next) => {
  try {
    const project = projectGuard(req, res);
    if (!project) return;
    const wsRoot = getProjectWorkspace(req.params.pid);
    const file = path.join(wsRoot, 'canvas.html');
    let html;
    try {
      html = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'canvas.html not yet generated' });
      throw err;
    }
    const filename = `${safeFilename(project.name)}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(html);
  } catch (err) { next(err); }
});

// ── PDF ──
router.get('/:pid/exports/pdf', async (req, res, next) => {
  try {
    const project = projectGuard(req, res);
    if (!project) return;
    const wsRoot = getProjectWorkspace(req.params.pid);
    const file = path.join(wsRoot, 'canvas.html');
    try {
      await fs.access(file);
    } catch {
      return res.status(404).json({ error: 'canvas.html not yet generated' });
    }

    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      return res.status(500).json({
        error: 'playwright chromium not installed — run `npx playwright install chromium`',
        details: err.message,
      });
    }

    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      // file:// 加载本地 HTML，让相对资源（assets/）能被解析
      const fileUrl = 'file://' + file;
      await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      const pdfBuffer = await page.pdf({
        width: '1280px',
        height: '720px',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      await ctx.close();

      const filename = `${safeFilename(project.name)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Length', pdfBuffer.length);
      res.end(pdfBuffer);
    } finally {
      await browser.close().catch(() => { /* ignore */ });
    }
  } catch (err) { next(err); }
});

// ── Handoff zip ──
router.get('/:pid/exports/handoff', async (req, res, next) => {
  try {
    const project = projectGuard(req, res);
    if (!project) return;
    const wsRoot = getProjectWorkspace(req.params.pid);
    const runs = listRunsForProject(req.params.pid);

    const zipBuffer = await buildHandoffZip(wsRoot, {
      projectId: project.id,
      projectName: project.name,
      skillId: project.skillId,
      runs,
    });

    const filename = `${safeFilename(project.name)}-handoff.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.end(zipBuffer);
  } catch (err) { next(err); }
});

/**
 * 共享 handoff 打包逻辑 —— 同时给 HTTP 路由和 MCP tool（C10 export_handoff）调。
 *
 * @param {string} workspaceRoot  绝对路径
 * @param {object} info
 * @param {string} info.projectId
 * @param {string} info.projectName
 * @param {string} [info.skillId]
 * @param {Array<{ id: string }>} [info.runs]  来自 listRunsForProject
 * @returns {Promise<Buffer>}  完整 zip 内容
 */
export async function buildHandoffZip(workspaceRoot, { projectId, projectName, skillId, runs = [] } = {}) {
  const zip = new JSZip();

  // design/canvas.html
  try {
    const html = await fs.readFile(path.join(workspaceRoot, 'canvas.html'), 'utf8');
    zip.file('design/canvas.html', html);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    zip.file('design/canvas.html', '<!-- canvas.html not yet generated -->');
  }

  // design/spec.json
  try {
    const spec = await fs.readFile(path.join(workspaceRoot, 'spec.json'), 'utf8');
    zip.file('design/spec.json', spec);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // design/assets/*
  const assetsDir = path.join(workspaceRoot, 'assets');
  try {
    const entries = await fs.readdir(assetsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const buf = await fs.readFile(path.join(assetsDir, e.name));
      zip.file(`design/assets/${e.name}`, buf);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // chat-history.json — 从 runs 抽简版
  const chatHistory = (runs || []).map((row) => ({ runId: row.id }));
  zip.file('chat-history.json', JSON.stringify({ projectId, runs: chatHistory }, null, 2));

  zip.file('prompt.txt', '');
  zip.file('README.md', renderReadme({ id: projectId, name: projectName, skillId }));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderReadme(project) {
  return `# ${project.name}

NoDesign 工程交付包。

## 文件结构

- \`design/canvas.html\` — 单文件 self-contained HTML，主产物
- \`design/spec.json\` — 设计意图档案（agent 私域记忆）
- \`design/assets/\` — 用户上传的素材
- \`chat-history.json\` — 此 project 跑过的 runs 摘要
- \`prompt.txt\` — 最近一次 user input

## 怎么用

直接在浏览器打开 \`design/canvas.html\` 看 deck。
导出 PDF：用浏览器打印（1280×720 视口最佳）。

---
导出时间：${new Date().toISOString()}
项目 ID：${project.id}
Skill：${project.skillId}
`;
}

export default router;
