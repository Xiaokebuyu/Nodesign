/**
 * server/api/publish.js — 站点一键上线的 HTTP 面（2026-08-02）
 *
 *   GET    /:pid/publish/:task   → { published, site? }
 *   POST   /:pid/publish/:task   → 发布/重发布（同步等 deploy 完，前端转圈）
 *   DELETE /:pid/publish/:task   → 下线
 *
 * 核心逻辑（闸门/staging/wrangler/custom domain）在 lib/site-publish.js ——
 * agent 的 MCP 工具 publish_site 和这里共用同一套。权限：HTTP 面按请求者算
 * （guardProject 已保证是 owner 或 admin）。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { publishSite, unpublishSite, validTaskName, lookupPublished } from '../lib/site-publish.js';
import { msg } from '../shared/messages.js';

const router = express.Router();

// 根站（扁平化后站点住工作区根）的 store key 是 '.'，但 '.' 进不了 URL 路径段：
// WHATWG URL 规范把单点段（含 %2E）就地归一掉，浏览器发出去就成了 /publish/。
// 所以路由双注册：无 :task 段 = 根站。
const taskOf = (req) => (req.params.task ?? '.');

router.get(['/:pid/publish', '/:pid/publish/:task'], async (req, res) => {
  if (!guardProject(req, res)) return;
  const task = taskOf(req);
  if (!validTaskName(task)) return res.status(400).json({ error: 'invalid task' });
  // lookupPublished 而不是 getPublished：key 已经收敛到站点根，但界面/老链接
  // 传别名过来时也该认得出，否则会显示"未上线"→ 用户再点一次 → 造出第二个部署
  const site = await lookupPublished(req.params.pid, task);
  res.json({ published: !!site, site });
});

router.post(['/:pid/publish', '/:pid/publish/:task'], async (req, res) => {
  if (!guardProject(req, res)) return;
  try {
    const { site, warning, certReady, root, files, entry } = await publishSite({
      projectId: req.params.pid, task: taskOf(req),
      root: typeof req.body?.root === 'string' ? req.body.root : undefined,
      slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined,
      user: req.user,
    });
    res.json({ site, warning, certReady, root, files, entry });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[publish] deploy failed:', err.stderr || err.message);
    res.status(502).json({ error: msg(req, '发布失败：Cloudflare 部署没成功，稍后再试') });
  }
});

router.delete(['/:pid/publish', '/:pid/publish/:task'], async (req, res) => {
  if (!guardProject(req, res)) return;
  try {
    const removed = await unpublishSite({ projectId: req.params.pid, task: taskOf(req) });
    if (!removed) return res.status(404).json({ error: 'not published' });
    res.json({ removed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[publish] delete failed:', err.stderr || err.message);
    res.status(502).json({ error: msg(req, '下线失败，稍后再试') });
  }
});

export default router;
