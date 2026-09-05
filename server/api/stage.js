/**
 * server/api/stage.js —— 演出（RP 显示器）的 HTTP 面（2026-08-29 建；2026-09-05 接上演出进程）
 *
 * 两族路由住一个文件：
 *
 *   /stage/echo             08-29 的旧件：用户在画布上对角色说话时先把这句落在板上。
 *                           前身 api/roles.js 的收件箱 08-29 整族退役，只剩这一件。
 *
 *   /stage/view|state|events|say|start|stop|config
 *                           09-05 的显示器管线。**这条路上没有主 agent**：显示器（一张
 *                           服务端现渲染的页面，装在 iframe 里）直接 POST say 进演出进程
 *                           的队列，台上写出来的每一拍经 SSE 推回来。主 agent 只在开戏时
 *                           用 open_stage 交一次系统提示词。
 *
 * 显示器为什么是服务端一条路由而不是前端组件：它要跟站点产物走同一条路（画布上一张卡、
 * 双击开最大化窗），而那条路的内容层就是"一个 iframe 装一个 URL"。做成路由，卡片预览
 * 和最大化窗装的是**同一个页面**，不用写两遍渲染。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { guardProject } from './_guard.js';
import { echoUserChalk } from '../engine/runs/user-chalk-echo.js';
import { getProjectBus } from '../ws/broker.js';
import {
  stageState, startStage, stopStage, sayToStage, patchStageConfig, subscribeStage, saveStageFile,
} from '../engine/stage/manager.js';

const router = express.Router();
const DISPLAY_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/stage/display.html');

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

// ── 显示器管线（2026-09-05）──

/** 错误带 status 的（manager 抛的 403/404/409/503）按它的码回，别一律 500 */
function sendErr(res, err) {
  const status = Number(err?.status) || 500;
  res.status(status).json({ error: err?.message || 'stage error' });
}

/** 显示器页面本体。卡片预览和最大化窗装的是同一个 URL（`?embed=1` 只是少了输入框）。 */
router.get('/:pid/stage/view', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!guardProject(req, res)) return;
    const html = await fs.readFile(DISPLAY_HTML, 'utf8');
    res.type('html').send(html);
  } catch (err) { next(err); }
});

router.get('/:pid/stage/state', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const st = await stageState(req.params.pid);
    if (!st) return res.status(404).json({ error: 'no stage in this project' });
    res.json(st);
  } catch (err) { next(err); }
});

/**
 * SSE：先整份快照（hello），之后跟事件。
 * nginx 前面要 `X-Accel-Buffering: no`，不然它把流攒到 4KB 才放，台上的字会一坨一坨地到。
 */
router.get('/:pid/stage/events', async (req, res) => {
  if (!guardProject(req, res)) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': stage\n\n');
  const off = await subscribeStage(req.params.pid, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断了下面 close 会收 */ } }, 25_000);
  req.on('close', () => { clearInterval(ping); off(); });
});

/** 用户对台上说一句（把手也走这条：点一枚 = 说了那句 prompt）。进程没在跑就顺手起。 */
router.post('/:pid/stage/say', express.json({ limit: '64kb' }), async (req, res) => {
  const project = guardProject(req, res);
  if (!project) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 8000) return res.status(400).json({ error: 'text too long' });
  try {
    res.json({ ok: true, ...(await sayToStage(req.params.pid, text, { userId: req.user?.id || null })) });
  } catch (err) { sendErr(res, err); }
});

/**
 * 开演 / 重开。正路是主 agent 的 open_stage 工具；这里给用户手动重开（散场后、服务端
 * 重启后）和带配置的直开（body 里给 systemPrompt —— 站主自己调试用，前端不暴露）。
 */
router.post('/:pid/stage/start', express.json({ limit: '256kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const b = req.body || {};
  const cfg = (b.table || b.systemPrompt) ? {
    title: b.title, table: b.table ? String(b.table) : undefined,
    systemPrompt: b.systemPrompt ? String(b.systemPrompt) : undefined,   // 09-05 之前的形状，还认
    cast: b.cast, vitals: b.vitals, skin: b.skin, model: b.model,
  } : null;
  try { res.json(await startStage(req.params.pid, cfg)); } catch (err) { sendErr(res, err); }
});

/**
 * 用户在画布上改台面 / 角色卡（md 阅读器的编辑态）。只收这两种路径；角色卡的机器块
 * （记忆索引）以磁盘为准接回去，用户改不坏它。改完进程不立刻重开 —— 下一句话到时 manager
 * 看 mtime 自己重开（用户感知：那一句慢十秒）。
 */
router.put('/:pid/stage/file', express.json({ limit: '256kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const rel = String(req.body?.path || '');
  const text = String(req.body?.text ?? '');
  try {
    res.json(await saveStageFile(req.params.pid, rel, text));
  } catch (err) { sendErr(res, err); }
});

router.post('/:pid/stage/stop', async (req, res) => {
  if (!guardProject(req, res)) return;
  try { res.json(await stopStage(req.params.pid, 'user')); } catch (err) { sendErr(res, err); }
});

/** 皮肤 / 标题 / 在场者 / 状态面板。systemPrompt 不在这儿改 —— 那要重开一场。 */
router.patch('/:pid/stage/config', express.json({ limit: '64kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  try { res.json(await patchStageConfig(req.params.pid, req.body || {})); } catch (err) { sendErr(res, err); }
});

export default router;
