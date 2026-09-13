/**
 * server/api/task-stop.js —— 停掉一个正在跑的子代理，不打断整轮（2026-09-13）
 *
 * POST /api/projects/:pid/sessions/:sid/tasks/:taskId/stop
 *   200 { ok: true }
 *   400 { code: 'BAD_TASK_ID' }
 *   404 { code: 'NO_ACTIVE_TURN' }   这个会话此刻没有属于该项目的在飞回合（前台子代理只活在回合里）
 *   404 { code: 'TASK_NOT_STOPPABLE' } SDK 拒了（任务已结束 / id 不存在）
 *
 * 以前用户只能停整轮（query.interrupt）。SDK 的 Query.stopTask(taskId) 能单停一个任务：09-13 真跑探针，
 * 前台子代理 6 秒时调用，立刻 task_notification(stopped)、它内部的 Bash 一并停掉，主 agent 收到
 * "[Request interrupted by user for tool use]" 的工具结果后照常把这一轮说完。taskId 就是 run.task.* 事件里那个。
 *
 * 跨租户锁：会话句柄在全局 Map 里、key 只有 sid，所以跟 guardRunInProject 同一个思路 ——
 * 取这个会话当前回合的 runId，runs 表里它必须属于 :pid。
 */
import { Router } from 'express';
import { guardProject } from './_guard.js';
import { getCurrentTurnRunId, querySessionInProject } from '../engine/runs/active-runs.js';
import { getRun } from '../engine/runs/store.js';   // runs 表行带 projectId（跟 guardRunInProject 同一个来源）

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 纯逻辑（依赖可注入，单测不起 express / 不碰库） */
export async function stopSessionTask({ pid, sid, taskId }, deps = { getCurrentTurnRunId, getQuerySession: (s, p) => querySessionInProject(s, p), getRun }) {
  if (!TASK_ID_RE.test(String(taskId || ''))) return { status: 400, body: { error: 'invalid task id', code: 'BAD_TASK_ID' } };
  const runId = deps.getCurrentTurnRunId(sid);
  const run = runId ? deps.getRun(runId) : null;
  const rec = deps.getQuerySession(sid, pid);   // 句柄本身也按项目取（09-13），不只靠当前回合的 runId
  if (!run || run.projectId !== pid || typeof rec?.query?.stopTask !== 'function') {
    return { status: 404, body: { error: 'no active turn in this session', code: 'NO_ACTIVE_TURN' } };
  }
  try {
    await rec.query.stopTask(taskId);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 404, body: { error: String(err?.message || err).slice(0, 200), code: 'TASK_NOT_STOPPABLE' } };
  }
}

const router = Router();
router.post('/:pid/sessions/:sid/tasks/:taskId/stop', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { status, body } = await stopSessionTask(req.params);
    res.status(status).json(body);
  } catch (err) { next(err); }
});

export default router;
