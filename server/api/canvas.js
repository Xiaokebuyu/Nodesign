/**
 * server/api/canvas.js — Canvas + Spec read/write/history/revert
 *
 * 路径（2026-08-13 起**项目级**，会话级留作 alias —— 同 pending-changes.js）：
 *   GET    /api/projects/:pid/assets/*subPath      单文件（iframe 内相对资源）
 *   GET    /api/projects/:pid/canvas               → text/html
 *   GET    /api/projects/:pid/canvas/deck-meta     deck 比例信息
 *   PUT    /api/projects/:pid/canvas               { html, source?, path? }
 *   GET    /api/projects/:pid/canvas/history       git log
 *   POST   /api/projects/:pid/canvas/revert        { commit }
 *   POST   /api/projects/:pid/canvas/undo
 *   GET    /api/projects/:pid/spec                 spec.json（agent 私域档案）
 *   GET    /api/projects/:pid/config               session-config.json
 *   PATCH  /api/projects/:pid/config
 *   （/:pid/sessions/:sid/... 同 handler 双挂载 —— 老前端和 jsonl 里的历史引用
 *     还打得通；扁平化后 sessionRoot === 工作区根，这批文件从来就是每项目一份。
 *     真正 per-session 的数据（.nd/<sid>/、PUT /sessions/:sid/model）不在本文件，
 *     那些保持 sid 专属，见 sessions.js。）
 *
 * 文件实际位置（扁平化后全在工作区根）：
 *   <workspace>/canvas.html、spec.json、session-config.json、assets/、.git/
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import {
  ensureSessionWorkspace, validateSessionId,
  getWorkspaceRoot, ensureProjectWorkspace,
  commitWorkspace, listHistory, revertWorkspace,
} from '../projects/workspace.js';
import { fitInjectionBlock } from './standalone-fit.js';
import { resolveDeckSize, extractDeckAspect } from '../shared/deck.js';
import { kindOfPath } from '../lib/artifact-target.js';
import {
  sendImage, isThumbPath, findOriginalForThumbnail, imageCacheControl,
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY,
} from '../lib/image-variant.js';
import { sendVideo, isVideo } from '../lib/video-variant.js';
import { readUiConfigFile, withUiDefaults, writeUiConfig } from '../projects/ui-config.js';

const router = express.Router();

const MAX_HTML_BYTES = 8 * 1024 * 1024; // 8MB

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

/** 两条挂载共用（只读路径）：alias 带 sid 走原路，项目级直接取工作区根 */
function rootOf(req) {
  // 两条挂载问的都是**画布真相**。2026-09-07 前 getSessionWorkspace 与 getWorkspaceRoot
  // 同值所以没露馅；文件夹项目里前者是用户仓库、后者是 .nodesign，这里要的是后者。
  // 带 sid 仍先校验 sid 形状（旧行为里 getSessionWorkspace 顺带做的那一步）。
  if (req.params.sid !== undefined) validateSessionId(req.params.sid);
  return getWorkspaceRoot(req.params.pid);
}

/** 两条挂载共用（写路径）：同上，但先 ensure 工作区存在 */
async function ensureRootOf(req) {
  // 同 rootOf：要的是画布真相。ensureSessionWorkspace 现在返回 cwd，所以只借它的副作用
  if (req.params.sid !== undefined) await ensureSessionWorkspace(req.params.pid, req.params.sid);
  else await ensureProjectWorkspace(req.params.pid);
  return getWorkspaceRoot(req.params.pid);
}

// 单文件 GET（assets/* 子树）—— 让 iframe 里 <img src="assets/generated/x.jpg">
// 自然解析 + chat 渲染 image content block 缩略图也走这个 endpoint。
// 走 sessions/<sid>/assets softlink 透到 shared/assets，路径限 assets/* 子树
// 防 traversal。MIME 按扩展名定。
const ASSET_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
// thumbnail 地址的解析与兜底（缺 thumb → 回原图 → 现编 512 webp）在
// lib/image-variant.js，artifact-file 路由吃的是同一份，两条路由行为一致。

router.get(['/:pid/assets/*subPath', '/:pid/sessions/:sid/assets/*subPath'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    // Express 5 named wildcard：req.params.subPath 是 string[] 或 string
    const raw = req.params.subPath;
    const subPath = Array.isArray(raw) ? raw.join('/') : (raw || '');
    if (!subPath) return res.status(400).json({ error: 'asset path required' });

    let absPath = path.resolve(sessionRoot, 'assets', subPath);
    const assetsRoot = path.resolve(sessionRoot, 'assets');
    // 防 traversal：resolve 后必须在 sessions/<sid>/assets/ 下
    if (absPath !== assetsRoot && !absPath.startsWith(assetsRoot + path.sep)) {
      return res.status(403).json({ error: 'path escapes assets/' });
    }

    // 请求的是不是缩略图地址 —— 决定 fallback 到原图之后要不要顺手缩到 512
    const wantsThumb = isThumbPath(absPath);

    let stat;
    let servedOriginalForThumb = false;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // ENOENT 兜底：thumbnail 路径不存在 → fallback 到原图（老图 / 生成失败 case）
      if (wantsThumb) {
        const original = await findOriginalForThumbnail(absPath);
        if (original) {
          absPath = original;
          stat = await fs.stat(original);
          servedOriginalForThumb = true;
        } else {
          return res.status(404).json({ error: 'thumbnail and original both missing' });
        }
      } else {
        return res.status(404).json({ error: 'asset not found' });
      }
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });

    const ext = path.extname(absPath).toLowerCase();
    // 带 ?v= 的是内容寻址 URL（源图一变 v 就变），可以永久缓存；不带的只能短缓存
    res.setHeader('Cache-Control', imageCacheControl(req));
    // 视频走 Range + 派生档（deck 里 <video src="assets/x.mp4"> 也打这条路由）
    if (isVideo(ext)) {
      return sendVideo(req, res, absPath, stat, {
        fallbackMime: ASSET_MIME[ext] || 'application/octet-stream',
      });
    }

    // 显示路径一律发派生图（原图只留给导出，见 lib/image-variant.js）。
    // 走 thumbnail 地址却拿到原图时补上 512 长边，等于把当年该生成的那张现补出来。
    return sendImage(req, res, absPath, stat, {
      fallbackMime: ASSET_MIME[ext] || 'application/octet-stream',
      maxDim: servedOriginalForThumb ? THUMBNAIL_MAX_DIM : null,
      quality: servedOriginalForThumb ? THUMBNAIL_QUALITY : undefined,
    });
  } catch (err) { next(err); }
});

/**
 * Preview-only：把 canvas.html 里 <img src="assets/generated/<name>.<ext>"> 透明
 * 重写成 src="assets/generated/.thumbnails/<name>.thumb.webp"。仅 GET /canvas serve
 * 时改输出，**不动** agent 写的源文件。
 *
 * 理由：单图原始 6-8MB（Gemini 默认 1080×1920+ PNG），iframe 缩放（zoom=transform
 * scale）+ 多图同时渲染让 GPU/RAM 暴涨，preview 体感卡。thumbnail 长边 512 / ~20KB
 * 足够 preview 看清布局。导出走 build-standalone 仍 inline 原图，最终交付不损质量。
 *
 * 也覆盖 CSS 内 url(...) 引用的图片（agent 用 background-image 时常见）。
 *
 * thumbnail 不存在时 asset endpoint 会自动 fallback 到原图（见下方 ENOENT 分支），
 * 老图（thumbnail 没生成的）/ 生成失败的都能正常显示。
 */
/**
 * 注入唯一权威 fit injection block（<script> + <style>）到 </body> 前。
 *
 * preview iframe 路径跟离线 / 导出 HTML 走同一份 standalone-fit，确保渲染一致：
 * 每 section 包 100vw×100vh frame + scroll-snap + CSS min() 缩放。
 *
 * 已含 __nd-standard-fit script 的跳过（重启场景：HTML 已经 saved 了）。
 */
function injectFitBlock(html) {
  if (/__nd-standard-fit\b/.test(html)) return html;
  const block = fitInjectionBlock();
  if (html.includes('</body>')) return html.replace('</body>', block + '\n</body>');
  if (html.includes('</html>')) return html.replace('</html>', block + '\n</html>');
  return html + block;
}

function rewriteImagesToThumbnails(html) {
  const imgRe = /(<img\b[^>]*\bsrc\s*=\s*["'])assets\/generated\/(?!\.thumbnails\/)([^"']+?)\.(png|jpg|jpeg|webp|gif)(["'])/gi;
  const cssUrlRe = /(url\(\s*["']?)assets\/generated\/(?!\.thumbnails\/)([^"')]+?)\.(png|jpg|jpeg|webp|gif)(["']?\s*\))/gi;
  return html
    .replace(imgRe, (_m, prefix, name, _ext, suffix) =>
      `${prefix}assets/generated/.thumbnails/${name}.thumb.webp${suffix}`)
    .replace(cssUrlRe, (_m, prefix, name, _ext, suffix) =>
      `${prefix}assets/generated/.thumbnails/${name}.thumb.webp${suffix}`);
}

router.get(['/:pid/canvas', '/:pid/sessions/:sid/canvas'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    const file = path.join(sessionRoot, 'canvas.html');
    try {
      let content = await fs.readFile(file, 'utf8');
      // 注入 <base href>：让 iframe 内 <img src="assets/...">/url("assets/...") 等
      // 相对资源解析显式锚到本工作区，不依赖 iframe.src 的隐式 base URL
      // （src 带 ?v=xxx query / 部署 redirect 等都可能让浏览器解析跑偏）。
      // 已含 <base> 时跳过；正则只匹配开始 <head> tag。
      // base 跟着请求进来的那条路走（项目级 / sid alias）——assets 两边都挂了，
      // 项目级页面锚到 sid 路径（或反过来）虽然也能通，但没必要跨范式。
      if (!/<base\s+href=/i.test(content)) {
        const baseHref = req.params.sid !== undefined
          ? `/api/projects/${encodeURIComponent(req.params.pid)}/sessions/${encodeURIComponent(req.params.sid)}/`
          : `/api/projects/${encodeURIComponent(req.params.pid)}/`;
        content = content.replace(/<head([^>]*)>/i, `<head$1>\n  <base href="${baseHref}">`);
      }
      // 透明替换 generated 图片为 thumbnail（preview 流畅；导出 / agent 看到的源
      // 文件不动）。env NODESIGN_DISABLE_THUMBNAIL_REWRITE=1 关掉这行为（应急）。
      if (process.env.NODESIGN_DISABLE_THUMBNAIL_REWRITE !== '1') {
        content = rewriteImagesToThumbnails(content);
      }
      // 注入唯一权威 fit script（每 section 自动包 100vw×100vh frame + scroll-snap）
      // preview iframe 跟离线打开 / 导出 HTML 共享同一 fit 行为，渲染一致
      content = injectFitBlock(content);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 还没生成（session 刚建，agent 没跑过）—— 占位 HTML
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(EMPTY_CANVAS_HTML);
      } else {
        throw err;
      }
    }
  } catch (err) { next(err); }
});

/**
 * GET /:pid/canvas/deck-meta —— 返 deck 比例信息
 *
 * 读 canvas.html wrap data-deck-aspect 属性 → resolve 到 4 档预设
 * （16:9 / 16:10 / 9:16 / 4:3），返 { aspect, width, height }。
 *
 * 用途：前端 Home 缩略图 / Workspace ThumbnailBox 需要在挂载前知道 deck
 * 比例才能正确设容器 aspectRatio + iframe size。Canvas 主路径自己会读
 * data-deck-aspect 不需要这个 endpoint。
 *
 * canvas.html 还没生成 → 返默认 16:9（让前端能用 fallback 占位）
 */
router.get(['/:pid/canvas/deck-meta', '/:pid/sessions/:sid/canvas/deck-meta'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    // ?path= 让任务 deck 也能问自己的比例（缺省旧式 cwd/canvas.html）
    const rel = typeof req.query.path === 'string' && req.query.path ? req.query.path : 'canvas.html';
    const file = path.resolve(sessionRoot, rel);
    let html = '';
    if (file === sessionRoot || file.startsWith(sessionRoot + path.sep)) {
      try { html = await fs.readFile(file, 'utf8'); } catch { /* canvas 还没生成 → 默认 16:9 fallback */ }
    }
    // kind 一起返回：站点没有"比例"这回事（响应式、高度不定），前端拿到
    // kind='site' 就别用下面这组数去套固定画框。不返 kind 的话前端只能拿到
    // 静默 fallback 的 16:9，把一个网站塞进 1920×1080 的信箱框里。
    const kind = await kindOfPath(sessionRoot, rel);
    const aspect = extractDeckAspect(html);
    const { width, height } = resolveDeckSize(aspect);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ kind, aspect, width, height });
  } catch (err) { next(err); }
});

/**
 * PUT /:pid/canvas —— 落库用户在画布上的直接编辑
 *
 * body.path（2026-07-28）：任务模型下 deck 住 tasks/<任务>/canvas.html，
 * 不带这个字段就会把用户的改动写进 sessions/<sid>/canvas.html —— 前端显示
 * "已保存"，用户看的那份却纹丝不动。缺省仍是旧式 cwd/canvas.html。
 */
router.put(['/:pid/canvas', '/:pid/sessions/:sid/canvas'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const { html, source = 'user', path: relPath } = req.body || {};
    if (typeof html !== 'string' || html.length === 0) {
      return res.status(400).json({ error: 'html string required' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      return res.status(413).json({ error: 'html too large (>8MB)' });
    }

    const sessionRoot = await ensureRootOf(req);
    const file = path.resolve(sessionRoot, typeof relPath === 'string' && relPath ? relPath : 'canvas.html');
    if (file !== sessionRoot && !file.startsWith(sessionRoot + path.sep)) {
      return res.status(400).json({ error: 'path escapes workspace' });
    }
    if (!file.endsWith('.html')) {
      return res.status(400).json({ error: 'path must be an .html file' });
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html, 'utf8');

    const ts = new Date().toISOString();
    const commit = await commitWorkspace(
      req.params.pid, req.params.sid,
      `${source}-edit: ${ts}`,
      { author: source === 'agent' ? 'agent' : 'user' },
    );
    res.json({ ok: true, commit });
  } catch (err) { next(err); }
});

// history / revert / undo：git 仓是项目级一个，workspace.js 三个 git helper 的
// sessionId 参数只是记出处 / 已不参与路径 —— 项目级挂载直接把 undefined 传下去
router.get(['/:pid/canvas/history', '/:pid/sessions/:sid/canvas/history'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await listHistory(req.params.pid, req.params.sid, { limit });
    res.json({ entries });
  } catch (err) { next(err); }
});

router.post(['/:pid/canvas/revert', '/:pid/sessions/:sid/canvas/revert'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const { commit } = req.body || {};
    if (!commit || typeof commit !== 'string') {
      return res.status(400).json({ error: 'commit hash required' });
    }
    const newCommit = await revertWorkspace(req.params.pid, req.params.sid, commit);
    res.json({ ok: true, commit: newCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post(['/:pid/canvas/undo', '/:pid/sessions/:sid/canvas/undo'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const entries = await listHistory(req.params.pid, req.params.sid, { limit: 5 });
    if (!entries || entries.length < 2) {
      return res.status(400).json({
        error: 'no previous version to undo to',
        code: 'NO_PREV_COMMIT',
      });
    }
    const prevCommit = entries[1].commit || entries[1].hash || entries[1].sha;
    if (!prevCommit) {
      return res.status(500).json({ error: 'history entry missing commit hash' });
    }
    const newCommit = await revertWorkspace(req.params.pid, req.params.sid, prevCommit);
    res.json({ ok: true, commit: newCommit, revertedTo: prevCommit });
  } catch (err) {
    if (err.code === 'INVALID_COMMIT') return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * GET /:pid/spec —— 读工作区根的 spec.json（agent 私域档案）
 *
 * 不存在或解析失败时返回 {} —— 让前端不会因 spec 缺失崩。
 * 这是只读 endpoint —— spec.json 完全由 agent 维护（mutateSpecJson 写的就是
 * 工作区根这份，hooks.js 读的也是它 —— 项目级挂载跟写入方同一落点）。
 * 注意：.nd/<sid>/ 里也有一份叫 spec.json 的会话私档（压缩摘要），那是另一回事，
 * 不走这条路由。
 */
router.get(['/:pid/spec', '/:pid/sessions/:sid/spec'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    const file = path.join(sessionRoot, 'spec.json');
    try {
      const raw = await fs.readFile(file, 'utf8');
      let spec = {};
      try { spec = JSON.parse(raw); } catch { spec = {}; }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) spec = {};
      res.json({ spec });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ spec: {} });
      throw err;
    }
  } catch (err) { next(err); }
});

// GET /plan endpoint 已删（Phase 4）；plan mode 整条线 2026-08-21 整体移除。

/**
 * GET /:pid/config —— 读项目级 UI 配置（ui-config.json，#25 从
 * session-config.json 改名 —— 扁平化后它就是项目级的了，旧名跟
 * .nd/<sid>/session-config.json（模型域，session-model.js 专管）同名不同域。
 * 读写细节和迁移策略在 projects/ui-config.js）
 *
 * 跟 spec.json 区分：
 *   - spec.json = agent 私域档案（agent 通过 record_decision/expose_tweaks/PostCompact 写）
 *   - ui-config.json = 用户/前端偏好（toggle 状态、UI 偏好）
 *
 * 当前字段：
 *   - tweaks_mode_enabled: bool   是否启用 Tweaks 模式（agent 主动暴露微调参数）
 *
 * 文件不存在时返回默认 config。
 */
router.get(['/:pid/config', '/:pid/sessions/:sid/config'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = rootOf(req);
    res.json({ config: withUiDefaults(await readUiConfigFile(sessionRoot)) });
  } catch (err) { next(err); }
});

/**
 * PATCH /:pid/config —— 部分更新 ui-config.json
 *
 * body: 任意 partial config（只覆盖传进来的字段）
 * 返回：merge 后的完整 config
 */
router.patch(['/:pid/config', '/:pid/sessions/:sid/config'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await ensureRootOf(req);
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'body must be object' });
    }
    // model 不能从这条泛用通道改：改模型除了写字段还要让跑着的 query 认账
    // （空闲时关掉重启），只写文件会让配置和进程各说各话。走
    // PUT /sessions/:sid/model —— 那条把两步绑在一起。
    if ('model' in patch) {
      return res.status(400).json({
        error: 'model 不能通过 config PATCH 修改，请用 PUT /sessions/:sid/model',
        code: 'USE_MODEL_ENDPOINT',
      });
    }
    const current = withUiDefaults(await readUiConfigFile(sessionRoot));
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeUiConfig(sessionRoot, merged);
    res.json({ config: merged });
  } catch (err) { next(err); }
});

const EMPTY_CANVAS_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>NoDesign canvas</title>
<style>html,body{margin:0;height:100%;font-family:system-ui;background:#F9F8F6}
.placeholder{display:flex;align-items:center;justify-content:center;height:100%;
color:#3a2a18aa;font-size:14px;letter-spacing:.02em}</style></head>
<body><div class="placeholder">canvas.html 还没生成 · 等 agent 跑一次 turn</div></body></html>
`;

export default router;
