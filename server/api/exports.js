/**
 * server/api/exports.js — 用户主动导出（H3：session-scoped）
 *
 * 路径全加 sid（H3 改造）：
 *   GET /api/projects/:pid/sessions/:sid/exports                列已生成交付包
 *   GET /api/projects/:pid/sessions/:sid/exports/file/:filename 单文件下载
 *   GET /api/projects/:pid/sessions/:sid/exports/html           导出 canvas.html
 *   GET /api/projects/:pid/sessions/:sid/exports/pdf            playwright print → PDF
 *   GET /api/projects/:pid/sessions/:sid/exports/handoff        JSZip 工程交付包
 *
 * 文件位置：
 *   <workspace>/sessions/<sid>/exports/  ← 已生成的导出包（agent 调
 *                                            mcp__nodesign__export_handoff 也写这）
 *   <workspace>/sessions/<sid>/canvas.html, spec.json
 *   <workspace>/shared/assets/           ← handoff 打包时从这取共享 assets
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { validateProjectId, getProject, listRunsForProject } from '../projects/store.js';
import {
  getSessionWorkspace, getSharedDir, validateSessionId,
} from '../projects/workspace.js';

const router = express.Router();

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

function safeFilename(name) {
  return (name || 'design').replace(/[^A-Za-z0-9._一-龥-]/g, '_').slice(0, 60);
}

// ── 已生成的交付包列表 ──
router.get('/:pid/sessions/:sid/exports', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const exportsDir = path.join(sessionRoot, 'exports');

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
        files.push({ name: e.name, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch { /* skip unreadable */ }
    }
    files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ files });
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/exports/file/:filename', async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);

    const filename = req.params.filename;
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const filePath = path.join(sessionRoot, 'exports', filename);
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

router.get('/:pid/sessions/:sid/exports/html', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
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

router.get('/:pid/sessions/:sid/exports/pdf', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
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

// PPTX：playwright 截每个 section[data-page] PNG → pptxgenjs 嵌图
// MVP 位图方案：用户拿到的 PPTX 文字不可编辑（每页是图），但视觉 1:1 还原
// 16:9 默认 layout（10" × 5.625"）匹配 deck 1280×720 比例
router.get('/:pid/sessions/:sid/exports/pptx', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const file = path.join(sessionRoot, 'canvas.html');
    try {
      await fs.access(file);
    } catch {
      return res.status(404).json({ error: 'canvas.html not yet generated' });
    }

    const { chromium } = await import('playwright');
    const PptxGenJS = (await import('pptxgenjs')).default;

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
      const fileUrl = 'file://' + file;
      await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30_000 });

      // 找所有 <section data-page="N">，按 data-page 升序截图
      const sectionHandles = await page.$$('section[data-page]');
      if (sectionHandles.length === 0) {
        await ctx.close();
        return res.status(400).json({
          error: 'canvas.html 没有 <section data-page="N"> 分页结构 — 无法转 PPTX',
        });
      }

      // 按 data-page 排序（防 DOM 顺序跟 page index 不一致）
      const pageInfos = [];
      for (const handle of sectionHandles) {
        const pageNum = await handle.getAttribute('data-page');
        pageInfos.push({ handle, pageNum: parseInt(pageNum, 10) || 0 });
      }
      pageInfos.sort((a, b) => a.pageNum - b.pageNum);

      // pptxgenjs 默认 LAYOUT_16x9 = 10" × 5.625"（hugely 适合 1280×720 deck）
      const pres = new PptxGenJS();
      pres.layout = 'LAYOUT_16x9';
      pres.title = safeFilename(project.name);

      for (const { handle, pageNum } of pageInfos) {
        const buf = await handle.screenshot({ type: 'png' });
        const slide = pres.addSlide();
        slide.addImage({
          data: `data:image/png;base64,${buf.toString('base64')}`,
          x: 0, y: 0, w: 10, h: 5.625,
        });
        // 顺手填 slide notes 标 page number 给 PPT 用户参考
        slide.addNotes(`Page ${pageNum} — exported from NoDesign canvas.html`);
      }
      await ctx.close();

      // pptxgenjs write 到 nodebuffer
      const pptxBuffer = await pres.write({ outputType: 'nodebuffer' });
      const filename = `${safeFilename(project.name)}.pptx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Length', pptxBuffer.length);
      res.end(pptxBuffer);
    } finally {
      await browser.close().catch(() => { /* ignore */ });
    }
  } catch (err) { next(err); }
});

router.get('/:pid/sessions/:sid/exports/handoff', async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const sharedRoot = getSharedDir(req.params.pid);
    const runs = listRunsForProject(req.params.pid);

    const zipBuffer = await buildHandoffZip(sessionRoot, sharedRoot, {
      projectId: project.id,
      projectName: project.name,
      skillId: project.skillId,
      sessionId: req.params.sid,
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
 * 共享 handoff 打包逻辑 —— HTTP 路由 + MCP tool（export_handoff）共用。
 *
 * @param {string} sessionRoot  sessions/<sid>/ 绝对路径（canvas/spec 在这）
 * @param {string} sharedRoot   shared/ 绝对路径（assets 在这）
 */
export async function buildHandoffZip(sessionRoot, sharedRoot, { projectId, projectName, skillId, sessionId, runs = [] } = {}) {
  const zip = new JSZip();

  try {
    const html = await fs.readFile(path.join(sessionRoot, 'canvas.html'), 'utf8');
    zip.file('design/canvas.html', html);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    zip.file('design/canvas.html', '<!-- canvas.html not yet generated -->');
  }

  try {
    const spec = await fs.readFile(path.join(sessionRoot, 'spec.json'), 'utf8');
    zip.file('design/spec.json', spec);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // assets 来自 shared/（跨 session 共享）
  const assetsDir = path.join(sharedRoot, 'assets');
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

  const chatHistory = (runs || []).map((row) => ({ runId: row.id }));
  zip.file('chat-history.json', JSON.stringify({ projectId, sessionId, runs: chatHistory }, null, 2));

  zip.file('prompt.txt', '');
  zip.file('README.md', renderReadme({ id: projectId, name: projectName, skillId, sessionId }));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderReadme(project) {
  return `# ${project.name}

NoDesign 工程交付包。

## 文件结构

- \`design/canvas.html\` — 单文件 self-contained HTML，主产物
- \`design/spec.json\` — 设计意图档案（agent 私域记忆）
- \`design/assets/\` — 项目共享素材
- \`chat-history.json\` — runs 摘要
- \`prompt.txt\` — 占位

## 怎么用

直接在浏览器打开 \`design/canvas.html\` 看 deck。
导出 PDF：用浏览器打印（1280×720 视口最佳）。

---
导出时间：${new Date().toISOString()}
项目 ID：${project.id}
Session ID：${project.sessionId}
Skill：${project.skillId}
`;
}

export default router;
