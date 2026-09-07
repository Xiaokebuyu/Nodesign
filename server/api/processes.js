/**
 * server/api/processes.js — 进程卡的接口（2026-09-07 桌面端·缝三）。只在本地版挂载（index.js）。
 *
 *   GET    /api/projects/:pid/processes                 登记表 + 盘上残留（lost）
 *   POST   /api/projects/:pid/processes { command, name?, cwd? }   用户自己起一个（面板 / 控制台）
 *   GET    /api/projects/:pid/processes/:id/log?tail=200
 *   POST   /api/projects/:pid/processes/:id/stop
 *   POST   /api/projects/:pid/processes/:id/restart
 *   DELETE /api/projects/:pid/processes/:id             只删不在跑的记录
 *
 * 实时变化不走这里：registry 往项目 EventBus 发 process.changed / process.log，前端订着。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import {
  startProcess, stopProcess, restartProcess, readProcessLog, listProcesses, removeProcess,
} from '../engine/process/registry.js';

const router = express.Router();

function fail(res, err) {
  if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

router.get('/:pid/processes', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json({ processes: await listProcesses(req.params.pid) });
  } catch (err) { next(err); }
});

router.post('/:pid/processes', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { command, name, cwd, waitMs } = req.body || {};
    const out = await startProcess({ projectId: req.params.pid, command, name, cwd, by: 'user', waitMs: waitMs ?? 3000 });
    res.status(201).json(out);
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.get('/:pid/processes/:id/log', (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const tail = Number(req.query.tail) || 200;
    res.json(readProcessLog(req.params.pid, req.params.id, { tail }));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.post('/:pid/processes/:id/stop', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json({ process: await stopProcess(req.params.pid, req.params.id) });
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.post('/:pid/processes/:id/restart', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json(await restartProcess(req.params.pid, req.params.id, { by: 'user', waitMs: 3000 }));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.delete('/:pid/processes/:id', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    await removeProcess(req.params.pid, req.params.id);
    res.json({ ok: true });
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

export default router;
