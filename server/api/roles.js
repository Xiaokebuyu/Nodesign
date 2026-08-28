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
import { deliver, inboxStates, isAsleep } from '../engine/agent/inbox.js';
import { listRoleNames } from '../engine/agent/role-card.js';
import { getWorkspaceRoot } from '../projects/workspace.js';
import { isResidentRole } from '../engine/agent/cast.js';
import { getScene } from '../engine/agent/scene.js';
import { isRpProject } from '../engine/agent/rp-mode.js';
import { broadcastStageNote } from '../engine/agent/stage-broadcast.js';
import { echoUserChalk } from '../engine/runs/user-chalk-echo.js';
import { getProjectBus } from '../ws/broker.js';

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

    // GM 中介路由（08-28 用户拍板）：rounds/directed 里**公开发言不直达** —— GM 收集、
    // 编排、把事件和走向转交给角色（引用用户原话，不改写）。这里只落痕不投递，前端
    // 拿到 routed:'gm' 会把这句话转投主对话（画布标注那条现成的路）把 GM 叫醒。
    // 私语（keep≠true）不受此限：悄悄话直达是它的语义，任何模式都通。
    // 顺带：旧的 onUserSay 开轮触发随中介路由退役 —— rounds 开轮只剩旁白落板一条路
    // （scene.onStageNote），私语不该开公开的轮。
    const scMode = getScene(req.params.pid)?.mode;
    if (isRpProject(req.params.pid) && req.body?.keep === true && (scMode === 'rounds' || scMode === 'directed')) {
      return res.json({ ok: true, routed: 'gm', name: names.get(slug), ...(echoRel ? { echo: echoRel } : {}) });
    }

    const r = deliver(req.params.pid, slug, { text, about, from: 'user', ...(echoRel ? { echo: echoRel } : {}) });
    // 台上广播（08-28 转发机）：**落了板的话是公开台词**，free 场里其他在场角色也听得见
    // （目标角色刚直投过，排除）。keep=false 的私语不落板也就不广播 —— 判据就是"在不在板上"。
    if (echoRel) {
      try { broadcastStageNote(req.params.pid, { rel: echoRel, by: 'user', text, exclude: [slug] }); }
      catch { /* 广播坏了不拦投递 */ }
    }
    res.json({
      ok: true, ...r, name: names.get(slug),
      // 散场角色收不到直投（进队列它也不会来取）—— 如实报给前端，前端据此托 GM 召回
      ...(r.delivered === 'queued' && isAsleep(req.params.pid, slug) ? { asleep: true } : {}),
      ...(echoRel ? { echo: echoRel } : {}),
    });
  } catch (err) { next(err); }
});

export default router;
