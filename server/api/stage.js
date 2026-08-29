/**
 * server/api/stage.js —— 用户在画布上对角色说话时，把这句话落在画布上（2026-08-29）
 *
 * 前身是 api/roles.js（名册 + 直投角色的收件箱）。收件箱 08-29 整族退役：角色不再
 * 挂着等人说话，用户的话一律经主持人转交（它本来就要在这一拍写场面、排下一步）。
 * 剩下的这一件事跟收件箱无关，是**画布对话的完整性** —— 用户从画布说的话得在画布上
 * 留下痕迹，否则那条对话线上只有角色单方面的半边声道。
 *
 * 落痕先于转交：前端拿到这条的 rel 之后再把话发给主持人，主持人接得上线。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { echoUserChalk } from '../engine/runs/user-chalk-echo.js';
import { getProjectBus } from '../ws/broker.js';

const router = express.Router();

router.post('/:pid/stage/echo', express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 8000) return res.status(400).json({ error: 'text too long' });
    const anchor = typeof req.body?.anchor === 'string' ? req.body.anchor : null;

    const e = await echoUserChalk(req.params.pid, { text, anchor });
    if (e.seated) {
      getProjectBus(req.params.pid).publish({ type: 'board.updated', sessionId: null, summary: '你的话落在板上了' });
    }
    res.json({ ok: true, echo: e.rel });
  } catch (err) { next(err); }
});

export default router;
