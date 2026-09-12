/**
 * server/api/exports.js — 用户主动导出
 *
 * 路径（2026-08-13 起**项目级**，会话级留作 alias —— 同 pending-changes.js）：
 *   GET  /api/projects/:pid/exports                列已生成交付包
 *   GET  /api/projects/:pid/exports/file/:filename 单文件下载
 *   GET  /api/projects/:pid/exports/items          可单独导出的东西
 *   POST /api/projects/:pid/exports/pick           下载勾选的东西
 *   GET  /api/projects/:pid/exports/html           导出 canvas.html
 *   GET  /api/projects/:pid/exports/pdf            playwright print → PDF
 *   GET  /api/projects/:pid/exports/pptx           截图 → pptxgenjs
 *   GET  /api/projects/:pid/exports/site           整站打包
 *   GET  /api/projects/:pid/exports/handoff        JSZip 工程交付包（旧口径，待退役）
 *   POST /api/projects/:pid/exports/cards          按产物卡导出（→ exports/cards.js）
 *   （/:pid/sessions/:sid/exports/... 同 handler 双挂载。老 sid 路由**永远保留**：
 *     jsonl 历史里持久化了绝对 URL —— export-handoff.js:104 拼出来发给用户的
 *     下载链接就是这个形状，砍掉 alias 等于让所有历史消息里的链接变 404。）
 *
 * 文件位置（扁平化后全在项目工作区根）：
 *   <workspace>/exports/      ← 已生成的导出包（agent 调
 *                                 mcp__nodesign__export_handoff 也写这）
 *   <workspace>/canvas.html, spec.json
 *   <workspace>/assets/       ← handoff 打包时从这取共享 assets
 */

import express from 'express';
import { launchPerceptionBrowser } from '../engine/mcp/tools/helpers/perception-page.js';
import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { validateProjectId, getProject, listRunsForProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import {
  getSharedDir, getWorkspaceRoot, validateSessionId,
} from '../projects/workspace.js';
import { DECK } from '../shared/deck.js';
import { buildStandaloneHtml, isHybridHtml, inlineLocalImages } from './exports/build-standalone.js';
import {
  resolveCanvasTarget, KIND_SITE, ENTRY_FILE, formatAllowed,
} from '../lib/artifact-target.js';
import { makeCardsExportHandler } from './exports/cards.js';
import { can } from '../lib/kinds/index.js';
import { docxToPdfResponse } from './exports/docx-pdf.js';
import { prepareExportPage, injectViewportFit } from './exports/export-page.js';
// 旧交付包打包逻辑已拆到 ./exports/handoff.js（待退役）。这里 re-export 是因为
// MCP 工具 export_handoff 从本文件 import 它 —— 换那条路由时一起收拾。
export { buildHandoffZip } from './exports/handoff.js';
import { buildHandoffZip } from './exports/handoff.js';
import { walkTaskFiles, loadIgnore } from '../lib/task-scan.js';

const router = express.Router();

function guard(req, res) {
  // sid 只在走老 alias 时存在 —— 有就校验形状，没有就是项目级路由
  if (req.params.sid !== undefined) {
    try {
      validateSessionId(req.params.sid);
    } catch (err) {
      res.status(400).json({ error: err.message || 'invalid pid/sid' });
      return null;
    }
  }
  // pid 校验 + 存在性 + 归属（2026-07-30 多用户）统一走 guardProject
  return guardProject(req, res);
}

/**
 * 两条挂载共用：alias 带 sid 走原路，项目级直接取工作区根。
 * 导出全是读操作，不 ensure —— 工作区还不存在的话本来也没什么可导。
 * resolveCanvasTarget 的第三参（sid）照传 req.params.sid：undefined 时它只是
 * 跳过"当前会话正在做哪份产物"的记忆，落回全工作区寻址，正是项目级想要的。
 */
function rootOf(req) {
  // 两条挂载问的都是**画布真相**（文件夹项目里 cwd 是用户仓库，不是它）；带 sid 只校验形状
  if (req.params.sid !== undefined) validateSessionId(req.params.sid);
  return getWorkspaceRoot(req.params.pid);
}

// 按产物卡导出（2026-08-17 重做）实现在 ./exports/cards.js：跟这里的烘焙路由
// 不是一档东西（原样打包 vs 跑 playwright/esbuild）
router.post(['/:pid/exports/cards', '/:pid/sessions/:sid/exports/cards'],
  makeCardsExportHandler({ guard, rootOf }));

function safeFilename(name) {
  return (name || 'design').replace(/[^A-Za-z0-9._一-龥-]/g, '_').slice(0, 60);
}

// ── 已生成的交付包列表 ──
router.get(['/:pid/exports', '/:pid/sessions/:sid/exports'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
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

router.get(['/:pid/exports/file/:filename', '/:pid/sessions/:sid/exports/file/:filename'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);

    // 文件名只禁路径分隔与上跳；中文名要能下（agent 交付的包常叫「终焉之莉莉-交付.zip」）
    const filename = req.params.filename;
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
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

/**
 * GET /:pid/sessions/:sid/exports/items —— 当前任务里可以单独导出的东西
 *
 * 用户视角的"这次任务做出来的内容"：任务目录下的文件 + deck 真正引用到的图。
 * 不做整包，让用户勾选（?path= 指定别的 deck；缺省走统一寻址）。
 */
router.get(['/:pid/exports/items', '/:pid/sessions/:sid/exports/items'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    const items = [];
    const seen = new Set();
    const add = async (rel, kind) => {
      if (seen.has(rel)) return;
      const abs = path.resolve(sessionRoot, rel);
      if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) return;
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return;
        seen.add(rel);
        items.push({ path: rel, name: path.basename(rel), size: st.size, kind });
      } catch { /* 读不到就不列 */ }
    };

    // 产物自己的文件（统一扫描规则 task-scan.js：硬清单 + .ndignore 生效，
    // `_drafts/` 试作照列 —— 用户可能就想下某一版）。
    //
    // ⚠️ 扁平模型改造（2026-08-14）：老判据是 `target.task && target.taskDir`，
    // 而 artifact-target 在任务层拆掉后 task 恒 null（兼容字段）—— 那条
    // walkTaskFiles 分支从扁平化起就是死路，站点导出清单只剩入口页 + 引用图，
    // 子页 / 样式表 / 试作**全部静默缺席**。现按产物根收：
    //   - 住文件夹的站：整个产物目录（maxDepth 4）
    //   - 根站（artifactRel='.'）：工作区根还住着 notes/ assets/ 别的产物，
    //     全扫会把别家打包进去 —— 只收根层散文件（.md 除外，同前端
    //     resolveObjectId 的认领规则）+ `_drafts/`；引用图由下面的扫描补
    //   - deck / 单页站：本体一份（扁平后它住的文件夹是用户的收纳空间，
    //     可能装着不相干的东西，不能整夹打包）
    const isSite = target.ok && target.kind === KIND_SITE;
    const isDirArtifact = target.ok && isSite && !target.artifact?.single;
    if (isDirArtifact) {
      const rootRel = target.artifactRel === '.' ? '' : target.artifactRel;
      const files = await walkTaskFiles(target.artifactDir, {
        maxDepth: rootRel ? 4 : 3,
        includeDrafts: true,
      });
      for (const f of files) {
        if (!rootRel) {
          const rootLevel = !f.rel.includes('/');
          const isDraft = f.rel.startsWith('_drafts/');
          if (!rootLevel && !isDraft) continue;
          if (rootLevel && /\.md$/i.test(f.name)) continue;
        }
        const rel = rootRel ? `${rootRel}/${f.rel}` : f.rel;
        const kind = /\.html?$/i.test(f.name)
          ? (f.rel.startsWith('_drafts/') ? 'draft' : (isSite ? 'site-page' : 'deck'))
          : 'file';
        await add(rel, kind);
      }
    } else if (target.ok) {
      await add(target.relPath, isSite ? 'site-page' : 'deck');
    }

    // 产物引用到的图（相对它自己的目录解，落成 workspace 相对路径）。
    // 站点扫全部页面 —— 只扫入口页会漏掉子页独有的图，用户下下来是裂的。
    if (target.ok) {
      // 站点：所有 .html + .css 都可能引图；deck：就它自己那一份
      const sources = isSite
        ? items.filter(i => /\.(html?|css)$/i.test(i.path)).map(i => path.resolve(sessionRoot, i.path))
        : [target.absPath];
      for (const src of sources) {
        try {
          const html = await fs.readFile(src, 'utf8');
          const base = path.dirname(src);
          const refs = new Set();
          for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) refs.add(m[1] || m[2]);
          for (const m of html.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+?))\s*\)/gi)) refs.add((m[1] || m[2] || m[3] || '').trim());
          for (const r of refs) {
            if (!r || /^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i.test(r) || path.isAbsolute(r)) continue;
            const abs = path.resolve(base, r);
            if (!abs.startsWith(sessionRoot + path.sep)) continue;
            await add(path.relative(sessionRoot, abs).split(path.sep).join('/'), 'image');
          }
        } catch { /* 读不到就跳过这一份 */ }
      }
    }

    res.json({
      deck: target.ok ? target.relPath : null,
      kind: target.ok ? target.kind : null,
      task: target.ok ? target.task : null,
      items,
    });
  } catch (err) { next(err); }
});

/**
 * POST /:pid/sessions/:sid/exports/pick —— 下载勾选的东西
 * body: { paths: string[], filename?: string }
 * 单个文件直接流回；多个打成 zip。
 */
router.post(['/:pid/exports/pick', '/:pid/sessions/:sid/exports/pick'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter(p => typeof p === 'string') : [];
    if (paths.length === 0) return res.status(400).json({ error: 'paths required' });

    const files = [];
    for (const rel of paths) {
      const abs = path.resolve(sessionRoot, rel);
      if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) {
        return res.status(400).json({ error: `path escapes workspace: ${rel}` });
      }
      try {
        const st = await fs.stat(abs);
        if (st.isFile()) files.push({ rel, abs, size: st.size });
      } catch {
        return res.status(404).json({ error: `not found: ${rel}` });
      }
    }
    if (files.length === 0) return res.status(404).json({ error: 'nothing to export' });

    if (files.length === 1) {
      const only = files[0];
      const buf = await fs.readFile(only.abs);
      const name = path.basename(only.rel);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    // 包内路径：剥掉所有勾选项的公共目录前缀。deck 场景（全在同一个任务目录里）
    // 结果还是平铺的文件名；站点勾了子目录里的页面时保留 `css/style.css` 这层结构 ——
    // 一律 basename 会让 `pages/a.html` 和 `posts/a.html` 在包里撞成一个。
    const segs = files.map(f => f.rel.split('/').slice(0, -1));
    let common = segs[0] || [];
    for (const s of segs) {
      let i = 0;
      while (i < common.length && i < s.length && common[i] === s[i]) i++;
      common = common.slice(0, i);
    }
    const strip = common.length ? common.join('/') + '/' : '';
    const zip = new JSZip();
    for (const f of files) {
      zip.file(f.rel.startsWith(strip) ? f.rel.slice(strip.length) : f.rel, await fs.readFile(f.abs));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const name = `${safeFilename(req.body?.filename || project.name)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) { next(err); }
});

router.get(['/:pid/exports/html', '/:pid/sessions/:sid/exports/html'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    // 导出哪一份走统一寻址（?path= 显式 → 本会话当前 deck → 本会话名下的任务 deck
    // → cwd/canvas.html）。任务模型下 deck 不在 cwd，写死 cwd 会永远导出空（2026-07-28）
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (rejectFormat(res, target, 'html', '单页 HTML')) return;
    const file = target.absPath;
    let html;
    try {
      html = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'canvas.html not yet generated' });
      throw err;
    }

    // **fit script 只给 deck**（2026-07-28）：那段脚本把每个 section 包成
    // 100vw×100vh 的 frame + scroll-snap，是幻灯片范式。站点是自然滚动的长页，
    // 注进去等于把用户的网站改造成翻页器 —— 而且是导出物，坏了还带不回来。
    // 顺带 stripFitScripts 也要跳过：它按启发式删"像 fit 的脚本"，站点里正当的
    // `transform: scale(` 动画会被误删。
    const injectFit = target.kind !== KIND_SITE;

    // Hybrid 文件 → 走自包含构建管道（CDN 全 inline，离线可双击打开）
    // 老 deck（无 babel script）→ 降级到 injectViewportFit 文本替换
    // 任一步骤失败也降级——保证用户至少拿到能用的 HTML
    if (isHybridHtml(html)) {
      try {
        // baseDir = deck 自己的目录：任务 deck 写的是 ../../assets/generated/x.png
        html = await buildStandaloneHtml(html, { sessionRoot, baseDir: path.dirname(file), injectFit });
      } catch (err) {
        // standalone 任何一步炸——管道里图片 inline 也不会跑，用户拿到的 HTML
        // 离开 session 目录后 <img src="assets/..."> 全 404。降级路径必须仍把
        // 图片 inline 一遍兜底，否则一次 esbuild 失败 = 整个 deck 图片全丢。
        console.warn('[exports/html] standalone build failed, falling back to viewport-fit:', err.message);
        if (injectFit) html = injectViewportFit(html);
        try {
          html = await inlineLocalImages(html, path.dirname(file), sessionRoot);
        } catch (e2) {
          console.warn('[exports/html] image inline fallback also failed:', e2.message);
        }
      }
    } else {
      if (injectFit) html = injectViewportFit(html);
      try {
        html = await inlineLocalImages(html, path.dirname(file), sessionRoot);
      } catch (e) {
        console.warn('[exports/html] image inline (legacy path) failed:', e.message);
      }
    }

    const filename = `${safeFilename(project.name)}.html`;
    // application/octet-stream 绕过 Cloudflare HTML 处理（Auto Minify / Rocket Loader）
    // 否则 19MB base64 HTML 会被 CF 尝试 parse/minify → 吞吐降到 7KB/s
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.send(html);
  } catch (err) { next(err); }
});

// PDF：跟 PPTX 同款位图方案——截每页 PNG → 拼成 HTML → page.pdf 输出。
//
// 为什么不直接 page.pdf 渲染原 deck？Chromium PDF 后端对 Google Fonts 拆 80+
// 个 unicode-range subset + data URL inline 的 web font 无法做正常字体子集化
// 嵌入，全部退回 Type 3（路径填充）渲染——CJK 字体严重失真，跟 HTML/preview
// 对不上。截图方案把字体烤成像素，绕开 PDF 字体嵌入管道，视觉跟 HTML 1:1。
//
// 代价：PDF 文字不可选/不可搜索（位图）；文件略大（每页一张 PNG）。
// 跟 PPTX 已有方案对齐——用户工作流"看完发邮件/打印"为主，可接受。
router.get(['/:pid/exports/pdf', '/:pid/sessions/:sid/exports/pdf'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (rejectFormat(res, target, 'pdf', 'PDF')) return;
    // 可渲染形态（docx）走 LibreOffice，不碰 playwright —— 下面整段是 deck 的
    // `<section data-page>` 逻辑，对 docx 一行都不适用。按能力位分流，跟感知层同一条规矩。
    if (can(target.kind, 'renderable')) return await docxToPdfResponse(res, target);
    const file = target.absPath;

    let browser;
    try {
      browser = await launchPerceptionBrowser();
    } catch (err) {
      return res.status(500).json({
        error: 'playwright chromium not installed — run `npx playwright install chromium`',
        details: err.message,
      });
    }

    let prepCleanup = async () => {};
    try {
      const { page, ctx, pageSize, cleanup } = await prepareExportPage(browser, file, { sessionRoot });
      prepCleanup = cleanup;

      const sectionHandles = await page.$$('section[data-page]');
      if (sectionHandles.length === 0) {
        await ctx.close();
        return res.status(400).json({
          error: 'canvas.html 没有 <section data-page="N"> 分页结构 — 无法转 PDF',
        });
      }

      // 拿排好序的 section + bbox（跟 PPTX 路径完全一致）
      const pageInfos = [];
      for (const handle of sectionHandles) {
        const pageNum = await handle.getAttribute('data-page');
        const bbox = await handle.boundingBox();
        pageInfos.push({ handle, pageNum: parseInt(pageNum, 10) || 0, bbox });
      }
      pageInfos.sort((a, b) => a.pageNum - b.pageNum);

      // 每页截图（pageSize 已被 prepareExportPage 中和掉 fit transform，原坐标）。
      // 用 JPEG 不用 PNG：图片自包含之后每页都是整幅照片级画面，PNG 无损一页
      // 就 5-8MB，7 页的 PDF 能到 60MB —— 发不出去的东西等于没导出。
      // q=88 的 JPEG 在同画面下小一个数量级，肉眼看不出差别（deck 本来就是看的）。
      const pngs = [];
      for (const { handle, bbox } of pageInfos) {
        const clipOpts = bbox
          ? { clip: { x: bbox.x, y: bbox.y, width: pageSize.w, height: pageSize.h } }
          : {};
        const buf = await handle.screenshot({ type: 'jpeg', quality: 88, ...clipOpts });
        pngs.push(buf);
      }

      // 拼成多页 HTML：每页一个 .slide 容器 + img 满铺，page-break 控制分页
      const slidesHtml = pngs.map((buf) =>
        `<div class="slide"><img src="data:image/jpeg;base64,${buf.toString('base64')}"/></div>`,
      ).join('\n');

      const composeHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${pageSize.w}px ${pageSize.h}px; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .slide {
    width: ${pageSize.w}px;
    height: ${pageSize.h}px;
    page-break-after: always;
    page-break-inside: avoid;
    break-after: page;
    break-inside: avoid;
    overflow: hidden;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  img { display: block; width: 100%; height: 100%; }
</style></head><body>
${slidesHtml}
</body></html>`;

      // 复用同 page setContent —— 不需要新开 page，省一次 launch 开销
      await page.setContent(composeHtml, { waitUntil: 'load' });

      const pdfBuffer = await page.pdf({
        width: `${pageSize.w}px`,
        height: `${pageSize.h}px`,
        printBackground: true,
        preferCSSPageSize: true,
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
      await prepCleanup();
    }
  } catch (err) { next(err); }
});

// PPTX：playwright 截每个 section[data-page] PNG → pptxgenjs 嵌图
// MVP 位图方案：用户拿到的 PPTX 文字不可编辑（每页是图），但视觉 1:1 还原
// 16:9 默认 layout（10" × 5.625"）匹配 deck 1920×1080 比例（pageSize.h/pageSize.w * 10 公式自动算）
router.get(['/:pid/exports/pptx', '/:pid/sessions/:sid/exports/pptx'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (rejectFormat(res, target, 'pptx', 'PPTX')) return;
    const file = target.absPath;

    const PptxGenJS = (await import('pptxgenjs')).default;

    let browser;
    try {
      browser = await launchPerceptionBrowser();
    } catch (err) {
      return res.status(500).json({
        error: 'playwright chromium not installed — run `npx playwright install chromium`',
        details: err.message,
      });
    }

    let prepCleanup = async () => {};
    try {
      const { page, ctx, pageSize, cleanup } = await prepareExportPage(browser, file, { sessionRoot });
      prepCleanup = cleanup;

      const sectionHandles = await page.$$('section[data-page]');
      if (sectionHandles.length === 0) {
        await ctx.close();
        return res.status(400).json({
          error: 'canvas.html 没有 <section data-page="N"> 分页结构 — 无法转 PPTX',
        });
      }

      const pageInfos = [];
      for (const handle of sectionHandles) {
        const pageNum = await handle.getAttribute('data-page');
        const bbox = await handle.boundingBox();
        pageInfos.push({ handle, pageNum: parseInt(pageNum, 10) || 0, bbox });
      }
      pageInfos.sort((a, b) => a.pageNum - b.pageNum);

      const slideW = 10;
      const slideH = pageSize.h / pageSize.w * slideW;
      const pres = new PptxGenJS();
      pres.defineLayout({ name: 'DECK', width: slideW, height: slideH });
      pres.layout = 'DECK';
      pres.title = safeFilename(project.name);

      for (const { handle, pageNum, bbox } of pageInfos) {
        const clipOpts = bbox
          ? { clip: { x: bbox.x, y: bbox.y, width: pageSize.w, height: pageSize.h } }
          : {};
        // 同 PDF：JPEG 不用 PNG，否则一份 7 页 deck 的 pptx 能到几十 MB
        const buf = await handle.screenshot({ type: 'jpeg', quality: 88, ...clipOpts });
        const slide = pres.addSlide();
        slide.addImage({
          data: `data:image/jpeg;base64,${buf.toString('base64')}`,
          x: 0, y: 0, w: slideW, h: slideH,
        });
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
      await prepCleanup();
    }
  } catch (err) { next(err); }
});

/**
 * 形态 × 格式守卫（注册表驱动）：不适用的格式提前 400，不白烧 playwright /
 * esbuild。以前是 if kind === site 的散装判断，第三种形态进来就得再改一轮 ——
 * 现在各形态可用的格式表在 kinds/ 注册条目里，这里只查表。
 */
function rejectFormat(res, target, formatId, label) {
  if (formatAllowed(target.kind, formatId)) return false;
  res.status(400).json({
    error: `${target.relPath} 是 ${target.kind} —— ${label} 导出不适用于这种形态。`
      + (target.kind === KIND_SITE ? '站点请用「整站打包」（/exports/site）或导出菜单里的站点 zip。' : ''),
  });
  return true;
}

/**
 * GET /:pid/sessions/:sid/exports/site —— 整站打包
 *
 * 打的是**产物根**（手写站点 = 任务根，构建型站点 = dist/ 之类），不是源目录 ——
 * 用户要的是能直接发布的站，不是构建脚本和 md。扫描走统一规则（task-scan.js）：
 * 硬清单 + .ndignore + 跳 `_drafts/`，node_modules 打进 zip 这种事故从根上没了。
 *
 * 原样保留目录结构和文件名（相对链接才不会断），不注入 fit、不改写结构、不重命名。
 * 唯一的改写是**素材路径归一**：站点引用项目共享素材写的是 `../../assets/x.png`
 * （相对它在 workspace 里的位置），包里没有 workspace 这层，所以把素材拷进
 * `site/assets/` 并按每个文件自己的深度重写前缀 —— 子目录里的页面要 `../assets/`，
 * 写死成 `assets/` 就又裂一次。任务本地 assets/（推荐写法）本来就在包里，零改写。
 */
router.get(['/:pid/exports/site', '/:pid/sessions/:sid/exports/site'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);
    if (!target.ok) return res.status(404).json({ error: target.message });
    if (!formatAllowed(target.kind, 'site')) {
      return res.status(400).json({ error: `${target.relPath} 是 ${target.kind}，不是站点 —— 用 /exports/html 或 /exports/handoff。` });
    }
    if (target.artifact?.single) {
      return res.status(400).json({ error: `${target.relPath} 是单页产物，没有"整站"可打包 —— 用 /exports/html 导出这一页。` });
    }
    if (!target.taskDir) return res.status(400).json({ error: 'site must live in a task folder' });

    const zip = new JSZip();
    const referenced = new Map();   // workspace 相对路径 → 包内相对 site/ 的落点
    const baseDir = target.artifactDir || target.taskDir;
    const files = await walkTaskFiles(baseDir, {
      maxDepth: 6,
      ignore: await loadIgnore(target.taskDir),
      ignoreBase: target.taskDir,
    });

    for (const f of files) {
      if (!/\.(html?|css)$/i.test(f.name)) {
        try { zip.file(`site/${f.rel}`, await fs.readFile(f.abs)); } catch { /* 中途被删就跳过 */ }
        continue;
      }
      let text;
      try { text = await fs.readFile(f.abs, 'utf8'); } catch { continue; }
      // 先按原文收集引用（改写之后就找不回原路径了）
      for (const r of localRefsOf(text)) {
        const refAbs = path.resolve(path.dirname(f.abs), r);
        if (!refAbs.startsWith(sessionRoot + path.sep)) continue;
        if (refAbs.startsWith(target.taskDir + path.sep)) continue;   // 站内文件整目录已经打包了
        const wsRel = path.relative(sessionRoot, refAbs).split(path.sep).join('/');
        if (wsRel.startsWith('assets/')) referenced.set(wsRel, wsRel);
      }
      // `../../assets/…` → 按本文件深度重算前缀（根层是 `assets/`，一层子目录是 `../assets/`）
      const depth = f.rel.split('/').length;
      const up = '../'.repeat(depth - 1);
      zip.file(`site/${f.rel}`, text.replace(/(["'(])(?:\.\.\/)+assets\//g, `$1${up}assets/`));
    }

    for (const [wsRel, dst] of referenced) {
      try {
        zip.file(`site/${dst}`, await fs.readFile(path.resolve(sessionRoot, wsRel)));
      } catch { /* 引用了不存在的文件：页面里本来就是裂的，不因此让打包失败 */ }
    }

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const filename = `${safeFilename(target.task || project.name)}-site.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) { next(err); }
});

/** html/css 里引用的本地相对路径（排除 http(s):// data: 和绝对路径） */
function localRefsOf(text) {
  const refs = new Set();
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) refs.add(m[1] || m[2]);
  for (const m of text.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+?))\s*\)/gi)) refs.add((m[1] || m[2] || m[3] || '').trim());
  return [...refs].filter(r => r && !/^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i.test(r) && !path.isAbsolute(r));
}

router.get(['/:pid/exports/handoff', '/:pid/sessions/:sid/exports/handoff'], async (req, res, next) => {
  try {
    const project = guard(req, res);
    if (!project) return;
    const sessionRoot = rootOf(req);
    const sharedRoot = getSharedDir(req.params.pid);
    const runs = listRunsForProject(req.params.pid);
    const target = await resolveCanvasTarget(sessionRoot, req.query.path, req.params.sid);

    const zipBuffer = await buildHandoffZip(sessionRoot, sharedRoot, {
      projectId: project.id,
      projectName: project.name,
      skillId: project.skillId,
      // 项目级挂载没有 sid —— README 里那行落 null，不硬造一个
      sessionId: req.params.sid ?? null,
      runs,
      deckPath: target.ok ? target.relPath : ENTRY_FILE.deck,
      kind: target.ok ? target.kind : null,
    });

    const filename = `${safeFilename(project.name)}-handoff.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.end(zipBuffer);
  } catch (err) { next(err); }
});


export default router;

