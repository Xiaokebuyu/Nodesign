/**
 * server/api/plugins.js — Plugin 上传 / 列表 / 卸载（用户级 + project 级 两套 router）
 *
 * 用户级（跨 project 全局，挂在 /api/plugins）：
 *   GET    /api/plugins                                列用户级 plugin
 *   POST   /api/plugins/install                        上传 zip → ~/.nodesign/plugins/
 *   DELETE /api/plugins/:name                          卸载用户级 plugin
 *   GET    /api/plugins/:name/export                   打包成 zip 下载（09-08；只带 skill 和参考材料，见 lib/plugin-pack.js）
 *
 * Project 级（仅当前 project，挂在 /api/projects 跟 assets/turn 同前缀）：
 *   GET    /api/projects/:pid/plugins                  列 project 级 plugin
 *   POST   /api/projects/:pid/plugins/install          上传 zip → <pid>/shared/.claude/plugins/
 *   DELETE /api/projects/:pid/plugins/:name            卸载 project 级 plugin
 *
 * 上传流程（两轨同套）：
 *   1. multer 收 multipart `file` 字段到 memory buffer
 *   2. validatePluginZip(buffer) — hard-fail 立即 400 + 详细 errors[]
 *   3. 解压到 staging 临时目录（同一 root 下 .staging/<tmpId>/）
 *   4. 目标 plugin name 已存在：没 `?force=true` 返 409 + 当前装的 manifest；
 *      有 force：先 rm -rf 旧目录
 *   5. atomic rename staging → 目标
 *   6. 返 manifest + skills + warnings
 *
 * 安全：validator 已拦 path traversal / 保留 name / 大小 / 格式；extractPluginZip
 *   二次防御解压路径不出 staging dir；DELETE 校验 name 合规 + 不撞保留前缀。
 *
 * 复用：multer memoryStorage pattern from server/api/assets.js:13-26
 */

import express from 'express';
import multer from 'multer';

import { validateProjectId, getProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import {
  getUserPluginsRoot,
  getProjectPluginsRoot,
  listInstalledPluginsDetailed,
} from '../engine/agent/plugin-loader.js';
import { LIMITS } from '../lib/plugin-validator.js';
import {
  installPluginToRoot,
  uninstallFromRoot,
} from '../lib/plugin-install.js';
import { packPluginDir, findUserPluginDir } from '../lib/plugin-pack.js';

// 允许的上传 mime / 后缀（双轨：单 .md / zip）。multer fileFilter 拦其他类型。
const ALLOWED_MIME = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',  // 部分 OS 上 .zip 拿不到准确 mime；按 extension 兜底校验
  'text/markdown',
  'text/x-markdown',
  'text/plain',                // 部分 OS 上 .md 报 text/plain
]);
const ALLOWED_EXT_RE = /\.(md|zip)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.ZIP_MAX_BYTES },
  // fileFilter 不 throw error（避免被 express generic error handler 截到返 500），
  // 把 validation 错误存到 req 上 + reject 文件；handler 检查 req.fileValidationError 返 400
  fileFilter: (req, file, cb) => {
    const mimeOk = ALLOWED_MIME.has(file.mimetype);
    const extOk = ALLOWED_EXT_RE.test(file.originalname || '');
    if (mimeOk || extOk) return cb(null, true);
    req.fileValidationError = `不支持的文件类型 (mime=${file.mimetype} name=${file.originalname}) — 仅接受 .md 或 .zip`;
    cb(null, false);
  },
});

/** 统一处理 multer 阶段 reject：fileValidationError 优先于 no-file */
function rejectInvalidFile(req, res) {
  if (req.fileValidationError) {
    res.status(400).json({ error: req.fileValidationError });
    return true;
  }
  if (!req.file) {
    res.status(400).json({ error: 'no file (field name: file)' });
    return true;
  }
  return false;
}

// ── Router 1：用户级（挂 /api/plugins） ──
//
// 2026-07-30 起每个用户一个根（~/.nodesign/plugins/<userId>/）。之前是全站一个
// 共享目录：任何登录用户装的 plugin 会加载进所有人的 agent 会话，也能删别人的。
// 这里的 req.user 由 authGuard 挂（登录墙关闭时是 `_anon`），拿不到就 401 —— 没有
// 身份就没有"用户级"可言，不能退回共享根。

export const userPluginsRouter = express.Router();

/** 取当前请求者的 plugin 根；没有合法身份时直接回 401 并返 null */
function userRootOf(req, res) {
  const root = getUserPluginsRoot(req.user?.id);
  if (!root) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return root;
}

userPluginsRouter.get('/', async (req, res, next) => {
  try {
    const root = userRootOf(req, res);
    if (!root) return;
    const plugins = await listInstalledPluginsDetailed(root);
    res.json({ plugins });
  } catch (err) { next(err); }
});

userPluginsRouter.post('/install', upload.single('file'), async (req, res, next) => {
  try {
    const root = userRootOf(req, res);
    if (!root) return;
    if (rejectInvalidFile(req, res)) return;
    const force = req.query.force === 'true';
    const result = await installPluginToRoot(req.file.buffer, root, { force });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

// 导出：Skill 管理页那句「先导出文件互传」以前没有对应按钮。打出来的 zip 是 plugin-zip 形态，
// 传回 /install 直接认。找不到（含名字不合规 / 内置的）一律 404
userPluginsRouter.get('/:name/export', async (req, res, next) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const hit = await findUserPluginDir(req.user.id, req.params.name);
    if (!hit) return res.status(404).json({ error: 'plugin not found' });
    const { buffer } = await packPluginDir(hit.dir);
    res.set('Content-Disposition', `attachment; filename="${hit.plugin.name}-${hit.plugin.version || '0.0.0'}.zip"`);
    res.type('application/zip').send(buffer);
  } catch (err) { next(err); }
});

userPluginsRouter.delete('/:name', async (req, res, next) => {
  try {
    const root = userRootOf(req, res);
    if (!root) return;
    const result = await uninstallFromRoot(root, req.params.name);
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

// ── Router 2：project 级（挂 /api/projects，跟 assets/turn 同前缀） ──

export const projectPluginsRouter = express.Router();

projectPluginsRouter.get('/:pid/plugins', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const root = getProjectPluginsRoot(req.params.pid);
    const plugins = await listInstalledPluginsDetailed(root);
    res.json({ plugins });
  } catch (err) { next(err); }
});

projectPluginsRouter.post('/:pid/plugins/install', upload.single('file'), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    if (rejectInvalidFile(req, res)) return;
    const force = req.query.force === 'true';
    const root = getProjectPluginsRoot(req.params.pid);
    const result = await installPluginToRoot(req.file.buffer, root, { force });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

projectPluginsRouter.delete('/:pid/plugins/:name', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const root = getProjectPluginsRoot(req.params.pid);
    const result = await uninstallFromRoot(root, req.params.name);
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

export default { userPluginsRouter, projectPluginsRouter };
