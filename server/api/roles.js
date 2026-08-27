/**
 * server/api/roles.js —— 常驻角色的对外入口（2026-08-26，块 4）
 *
 * GET  /api/projects/:pid/roles            角色名册 + 收件箱状态（谁在等你回话）
 * POST /api/projects/:pid/roles/:slug/say  用户对某个角色说一句（直达，不惊动主 agent）
 *
 * ## 为什么用户的话能"直达"
 *
 * 服务端没法给子代理投消息（SDK 没这个口，子代理唯一入口 SendMessage 是模型的工具）。
 * 所以方向是反的：角色自己挂在 `await_user` 上等，这个端点把话交给它。
 * 角色没在等的时候，话进队列 —— 那时**服务端叫不醒它**，得等它下次被唤醒自己来取。
 *
 * ⚠️ 这两种结果必须如实回给前端（`delivered: 'waiting' | 'queued'`）：
 * 把积压伪装成送达，用户就会对着一个没人听的板子说话。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { deliver, inboxStates } from '../engine/agent/inbox.js';
import { listRoleNames } from '../engine/agent/role-card.js';
import { getWorkspaceRoot } from '../projects/workspace.js';
import { isResidentRole } from '../engine/agent/cast.js';
import { onUserSay, getScene } from '../engine/agent/scene.js';
import { echoUserChalk } from '../engine/runs/user-chalk-echo.js';
import { getProjectBus } from '../ws/broker.js';
import { Events } from '../engine/agent/events.js';

const router = express.Router();

router.get('/:pid/roles', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const names = await listRoleNames(getWorkspaceRoot(req.params.pid));
    const states = inboxStates(req.params.pid);
    res.json({
      roles: [...names].map(([slug, name]) => ({
        slug, name, ...(states[slug] || { waiting: false, queued: 0 }),
      })),
      // 场声明（可能为 null）：前端初始加载用，之后靠 run.scene 事件增量
      scene: getScene(req.params.pid),
    });
  } catch (err) { next(err); }
});

router.post('/:pid/roles/:slug/say', express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { slug } = req.params;
    // slug 走同一个全局判据（cast.js 的 ROLE_SLUG_RE）—— 它同时是队列 key，
    // 别让路径参数里的怪东西进内存表的键空间
    if (!isResidentRole(slug)) return res.status(400).json({ error: 'bad role slug' });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 8000) return res.status(400).json({ error: 'text too long' });

    // 角色必须真的存在（有角色文件）。不存在还收下 = 用户对着空气说话，
    // 而且队列会为一个永远不会来取的 key 一直占着
    const names = await listRoleNames(getWorkspaceRoot(req.params.pid));
    if (!names.has(slug)) return res.status(404).json({ error: 'role not found' });

    const about = req.body?.about ? String(req.body.about).slice(0, 300) : null;

    // 落痕（2026-08-27 solo 画布对话）：keep=true 时同一句话落成 by:'user' 的板书
    // 接进线 —— 不落的话这条对话线在板上只有角色那半声道。**先落痕再投递**：
    // 收件箱消息要带上板书路径，角色回帖 reply_to 它线才接得上。失败不拦投递。
    let echoRel = null;
    if (req.body?.keep === true) {
      try {
        const anchor = typeof req.body?.anchor === 'string' ? req.body.anchor : null;
        const e = await echoUserChalk(req.params.pid, { text, anchor });
        echoRel = e.rel;
        if (e.seated) {
          getProjectBus(req.params.pid).publish({ type: 'board.updated', sessionId: null, summary: '你的话落在板上了' });
        }
      } catch (err) { console.warn('[roles/say] 落痕失败（投递照走）:', err?.message || err); }
    }

    const r = deliver(req.params.pid, slug, { text, about, from: 'user', ...(echoRel ? { echo: echoRel } : {}) });
    // 轮次机：rounds 模式下对 order 里的人说话 = 从那个人开一轮（scene.js）
    try {
      const sc = onUserSay(req.params.pid, slug);
      if (sc) getProjectBus(req.params.pid).publish({ ...Events.scene(sc), ts: new Date().toISOString() });
    } catch { /* 机器坏了不拦投递 */ }
    res.json({ ok: true, ...r, name: names.get(slug), ...(echoRel ? { echo: echoRel } : {}) });
  } catch (err) { next(err); }
});

export default router;
