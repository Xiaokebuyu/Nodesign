/**
 * assets/docx-page.js — `GET /:pid/docx-page` 的处理器。
 *
 * 画布上的缩略图和产物窗里的翻页吃的是同一份缓存：一次 LibreOffice 出整份，
 * 翻页零成本（详见 lib/docx-pages.js）。给 `w` 就缩到那个宽度出 webp，
 * 缩略图走这条 —— 不为小一号再起一次 soffice。
 *
 * 单开一个文件是因为它跟 assets.js 其余路由一行代码都不共享，而 assets.js
 * 已经压在行数棘轮的上限上。（依赖用注入的，不去 import assets.js 的内部件 ——
 * 那会绕成一个环。）
 *
 * ⚠️ 冷启第一次会真跑渲染（几百毫秒到两秒），前端要能等 —— **别在这条路上加
 * 超时重试**，重试只会把同一份文档排进闸门两次。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pageImage, docPdf } from '../../lib/docx-pages.js';
import { safeResolveRead } from '../../lib/safe-path.js';

import { msg } from '../../shared/messages.js';
/** 缩略图宽度上限：再大就不是缩略图了，纯粹是让服务端白干 */
const MAX_WIDTH = 2000;

export function makeDocxPageHandler({ getSharedDir, guardProject }) {
  return async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const rel = String(req.query.path || '').replace(/\\/g, '/');
      if (!rel || !/\.docx$/i.test(rel)) return res.status(400).json({ error: 'path 得是一个 .docx' });

      // ⚠️ 只做词法检查是不够的：工作区里一个指向 .env 的软链，路径逐字看都在
      // 工作区内，soffice 会老老实实把明文渲成一张 PNG 发出去。而这条路走的是
      // **没有沙盒的 server 进程**，绕开了给 agent 设的 permissions.deny。
      // 判据收在 lib/safe-path.js，别在这儿再抄一遍。
      const root = getSharedDir(req.params.pid);
      const abs = await safeResolveRead(root, rel);
      if (!abs) return res.status(403).json({ error: 'path escapes workspace' });

      let stat;
      try { stat = await fs.stat(abs); } catch { return res.status(404).json({ error: msg(req, '找不到这份文档') }); }

      // ETag 带 mtime + size：agent 一 rebuild 就换 key，浏览器自然重取
      const w = Math.min(Math.max(0, Number(req.query.w) || 0), MAX_WIDTH);
      const pageNo = Math.max(1, Number(req.query.page) || 1);
      const etag = `"${stat.mtimeMs}-${stat.size}-${pageNo}-${w}"`;
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      let out;
      try {
        out = await pageImage(abs, pageNo, w ? { width: w } : {});
      } catch (err) {
        console.warn('[docx-page] render failed:', err.message);
        return res.status(err.status || 500).json({
          error: msg(req, '渲染失败'),
          details: String(err.message || err).slice(0, 300),
        });
      }
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, max-age=60');
      // 页数给前端画翻页控件，省一次单独的请求
      res.set('X-Docx-Pages', String(out.count));
      res.type(out.mime).send(out.buf);
    } catch (err) { next(err); }
  };
}

/**
 * `GET /:pid/docx-pdf` —— 整份 PDF，产物窗「PDF 视图」的 iframe 吃它。
 * 跟页图同一份渲染缓存（docx → PDF 本来就是页图链路的中间站），同一套
 * mtime ETag：agent 一 rebuild 浏览器自然重取，视图永不陈旧。
 */
export function makeDocxPdfHandler({ getSharedDir, guardProject }) {
  return async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const rel = String(req.query.path || '').replace(/\\/g, '/');
      if (!rel || !/\.docx$/i.test(rel)) return res.status(400).json({ error: 'path 得是一个 .docx' });
      // 软链判据同上：收在 lib/safe-path.js，别抄
      const root = getSharedDir(req.params.pid);
      const abs = await safeResolveRead(root, rel);
      if (!abs) return res.status(403).json({ error: 'path escapes workspace' });
      let stat;
      try { stat = await fs.stat(abs); } catch { return res.status(404).json({ error: msg(req, '找不到这份文档') }); }
      const etag = `"${stat.mtimeMs}-${stat.size}-pdf"`;
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      let out;
      try {
        out = await docPdf(abs);
      } catch (err) {
        console.warn('[docx-pdf] render failed:', err.message);
        return res.status(err.status || 500).json({
          error: msg(req, '渲染失败'),
          details: String(err.message || err).slice(0, 300),
        });
      }
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, max-age=60');
      // inline：在浏览器的 PDF 阅读器里看，不触发下载（要文件走导出）
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(rel))}"`);
      res.type('application/pdf').send(out.buf);
    } catch (err) { next(err); }
  };
}
