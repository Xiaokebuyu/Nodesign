/**
 * server/api/stage.js —— 演出（RP 显示器）的 HTTP 面（2026-08-29 建；2026-09-05 接上演出进程，当晚改成一场戏一个文件夹）
 *
 *   /stage/echo                      08-29 的旧件：用户在画布上对角色说话时先把这句落在板上。
 *   /stage/plays                     这个项目有哪几场戏（顺手把老形状 stage/ 收进文件夹）
 *   /stage/ui/:file                  显示器的静态件（engine/stage/display/）
 *   /stage/:play/view                显示器页面（卡上和窗里装同一个 URL，?embed=1 是卡片态）
 *   /stage/:play/state|events(SSE)|say|start|stop|config(PATCH)|state(POST 用户拨值)
 *   /stage/:play/file(GET/PUT)|files|memory(DELETE)|images
 *
 * **这条路上没有主 agent**：显示器直接 POST say 进演出进程的队列，台上每一拍经 SSE 推回来。
 * `:play` 是戏的文件夹名（工作区根下一级，URL 编码）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { guardProject } from './_guard.js';
import { echoUserChalk } from '../engine/runs/user-chalk-echo.js';
import { getProjectBus } from '../ws/broker.js';
import {
  stageState, startStage, stopStage, sayToStage, patchStageConfig, subscribeStage, setUserState, ensurePlays, createPlay,
} from '../engine/stage/manager.js';
import { saveStageFile, readStageFile, listStageFiles, deleteMemory, listStageImages } from '../engine/stage/files.js';

const router = express.Router();
const DISPLAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/stage/display');
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

router.post('/:pid/stage/echo', express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 8000) return res.status(400).json({ error: 'text too long' });
    const anchor = typeof req.body?.anchor === 'string' ? req.body.anchor : null;
    const e = await echoUserChalk(req.params.pid, { text, anchor });
    if (e.seated) getProjectBus(req.params.pid).publish({ type: 'board.updated', sessionId: null, summary: '你的话落在板上了' });
    res.json({ ok: true, echo: e.rel });
  } catch (err) { next(err); }
});

function sendErr(res, err) {
  res.status(Number(err?.status) || 500).json({ error: err?.message || 'stage error' });
}
/** 戏的文件夹名：一级、不带路径分隔、不以点开头 */
function playOf(req, res) {
  const p = String(req.params.play || '');
  if (!p || p.includes('/') || p.includes('\\') || p.includes('..') || p.startsWith('.')) { res.status(400).json({ error: 'bad play' }); return null; }
  return p;
}

router.get('/:pid/stage/plays', async (req, res, next) => {
  try { if (!guardProject(req, res)) return; res.json({ plays: await ensurePlays(req.params.pid) }); } catch (err) { next(err); }
});

/** 显示器静态件。跟页面同源同鉴权（cookie），别的项目拿不到也无所谓，它们是公开代码 */
router.get('/:pid/stage/ui/:file', async (req, res) => {
  if (!guardProject(req, res)) return;
  const f = String(req.params.file || '');
  if (!/^[a-z0-9_-]+\.(html|css|js|svg|woff2)$/i.test(f)) return res.status(404).end();
  try {
    const buf = await fs.readFile(path.join(DISPLAY_DIR, f));
    res.setHeader('Cache-Control', 'no-cache');
    res.type(UI_TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream').send(buf);
  } catch { res.status(404).end(); }
});

router.get('/:pid/stage/:play/view', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!guardProject(req, res)) return;
    if (!playOf(req, res)) return;
    res.type('html').send(await fs.readFile(path.join(DISPLAY_DIR, 'index.html'), 'utf8'));
  } catch (err) { next(err); }
});

router.get('/:pid/stage/:play/state', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const play = playOf(req, res); if (!play) return;
    const st = await stageState(req.params.pid, play);
    if (!st) return res.status(404).json({ error: 'no such play' });
    res.json(st);
  } catch (err) { next(err); }
});

/** SSE：先整份快照（hello），之后跟事件。nginx 前面要 X-Accel-Buffering: no。 */
router.get('/:pid/stage/:play/events', async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': stage\n\n');
  const off = await subscribeStage(req.params.pid, play, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25_000);
  req.on('close', () => { clearInterval(ping); off(); });
});

router.post('/:pid/stage/:play/say', express.json({ limit: '64kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 8000) return res.status(400).json({ error: 'text too long' });
  try { res.json({ ok: true, ...(await sayToStage(req.params.pid, play, text, { userId: req.user?.id || null })) }); } catch (err) { sendErr(res, err); }
});

/**
 * 开演 / 重开。正路是主 agent 的 open_stage；这里给用户手动重开，和带配置的直开
 * （body 给 table / cast / rules —— 站主自己调试用，前端不暴露）。
 */
router.post('/:pid/stage/:play/start', express.json({ limit: '256kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  const b = req.body || {};
  try {
    let root = play;
    if (b.table || b.cast || b.rules) root = await createPlay(req.params.pid, { title: b.title || play, table: b.table, cast: b.cast, vitals: b.vitals, skin: b.skin, rules: b.rules, model: b.model });
    res.json(await startStage(req.params.pid, root));
  } catch (err) { sendErr(res, err); }
});

router.post('/:pid/stage/:play/stop', async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json(await stopStage(req.params.pid, play, 'user')); } catch (err) { sendErr(res, err); }
});

router.patch('/:pid/stage/:play/config', express.json({ limit: '64kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json(await patchStageConfig(req.params.pid, play, req.body || {})); } catch (err) { sendErr(res, err); }
});

/** 用户在状态页拨值：{ "好感": 60 } */
router.post('/:pid/stage/:play/state', express.json({ limit: '16kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json(await setUserState(req.params.pid, play, req.body || {})); } catch (err) { sendErr(res, err); }
});

router.get('/:pid/stage/:play/files', async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json({ files: await listStageFiles(req.params.pid, play) }); } catch (err) { sendErr(res, err); }
});
router.get('/:pid/stage/:play/file', async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json(await readStageFile(req.params.pid, play, String(req.query.path || ''))); } catch (err) { sendErr(res, err); }
});
/** 改台面 / 规则 / 角色卡 / 世界书 / 记忆正文。角色卡的机器块服务端保住；改完下一句话到时进程自己重开。 */
router.put('/:pid/stage/:play/file', express.json({ limit: '512kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json(await saveStageFile(req.params.pid, play, String(req.body?.path || ''), String(req.body?.text ?? ''))); } catch (err) { sendErr(res, err); }
});
router.delete('/:pid/stage/:play/memory', express.json({ limit: '4kb' }), async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json(await deleteMemory(req.params.pid, play, { name: String(req.query.name || req.body?.name || ''), who: req.query.who || req.body?.who || null })); } catch (err) { sendErr(res, err); }
});
router.get('/:pid/stage/:play/images', async (req, res) => {
  if (!guardProject(req, res)) return;
  const play = playOf(req, res); if (!play) return;
  try { res.json({ images: await listStageImages(req.params.pid, play) }); } catch (err) { sendErr(res, err); }
});

export default router;
