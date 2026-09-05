/**
 * server/api/stage.js —— 演出（RP 显示器）的 HTTP 面（2026-08-29 建；09-05 接上演出进程；09-06 加线路 / 开场 / 预设）
 *
 *   /stage/echo                      08-29 的旧件：用户在画布上对角色说话时先把这句落在板上。
 *   /stage/plays                     这个项目有哪几个故事（顺手把老形状 stage/ 收进文件夹）
 *   /stage/ui/:file                  显示器的静态件（engine/stage/display/）；/stage/ui/font/:name 是平台字体
 *   /stage/:play/view                显示器页面（卡上和窗里装同一个 URL，?embed=1 是卡片态）
 *   /stage/:play/state|events(SSE)|say|start|stop|config(PATCH)|state(POST 用户拨值)
 *   /stage/:play/file(GET/PUT)|files|memory(DELETE)|images
 *   /stage/:play/open                引导开场：写法 + 可选条目 → 起进程 → 发开场指令
 *   /stage/:play/presets|preset      写法预设清单 / 上传一份
 *   /stage/:play/lore                世界书触发条目清单（开关在 config.lore.off）
 *   /stage/:play/lines|rewind|fork|line   线路：清单 / 回到某句之前 / 从某句分叉 / 切线（POST）改名（PATCH）删（DELETE）
 *
 * **这条路上没有主 agent**：显示器直接 POST say 进演出进程的队列，台上每一段经 SSE 推回来。
 * `:play` 是故事的文件夹名（工作区根下一级，URL 编码）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { guardProject } from './_guard.js';
import { echoUserChalk } from '../engine/runs/user-chalk-echo.js';
import { getProjectBus } from '../ws/broker.js';
import {
  stageState, startStage, stopStage, sayToStage, patchStageConfig, subscribeStage, setUserState, ensurePlays, createPlay, runtimeOf, panelOp,
} from '../engine/stage/manager.js';
import { saveStageFile, readStageFile, listStageFiles, deleteMemory, listStageImages } from '../engine/stage/files.js';
import { listLines, rewindTo, forkAt, switchLine, renameLine, deleteLine } from '../engine/stage/lines.js';
import { openStory, uploadPreset } from '../engine/stage/opening.js';
import { listPresets } from '../engine/stage/preset.js';
import { loadWorldbook } from '../engine/stage/worldbook.js';
import { platform } from '../runtime/platform.js';

const router = express.Router();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPLAY_DIR = path.join(HERE, '../engine/stage/display');
const FONT_SRC_DIR = path.join(HERE, '../../web/src/assets/fonts');
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
/** 故事的文件夹名：一级、不带路径分隔、不以点开头 */
function playOf(req, res) {
  const p = String(req.params.play || '');
  if (!p || p.includes('/') || p.includes('\\') || p.includes('..') || p.startsWith('.')) { res.status(400).json({ error: 'bad play' }); return null; }
  return p;
}
/** 大部分路由的同一段开头：鉴权 + 文件夹名。返回 play 或 null（已经回了错） */
function enter(req, res) {
  if (!guardProject(req, res)) return null;
  return playOf(req, res);
}
/** 把一段 async 的结果 json 出去，错了按 status 回 */
const wrap = (fn) => async (req, res) => {
  const play = enter(req, res); if (!play) return;
  try { res.json(await fn(req, play)); } catch (err) { sendErr(res, err); }
};

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

/**
 * 平台字体（楷体）给显示器用：web 那边的 @font-face 指向带哈希的构建产物，显示器猜不到路径，
 * 所以这里从源目录（仓库里跑）或 dist/assets（只发了构建的）找同名文件。找不到就 404，显示器退回系统字体。
 */
router.get('/:pid/stage/ui/font/:name', async (req, res) => {
  if (!guardProject(req, res)) return;
  const name = String(req.params.name || '');
  if (!/^[a-z0-9-]+\.woff2$/i.test(name)) return res.status(404).end();
  const candidates = [path.join(FONT_SRC_DIR, name)];
  const dist = path.join(platform.webDistDir, 'assets');
  const stem = name.replace(/\.woff2$/i, '');
  for (const f of await fs.readdir(dist).catch(() => [])) if (f.startsWith(`${stem}-`) && f.endsWith('.woff2')) candidates.push(path.join(dist, f));
  for (const c of candidates) {
    try {
      const buf = await fs.readFile(c);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.type('font/woff2').send(buf);
    } catch { /* 下一个 */ }
  }
  res.status(404).end();
});

router.get('/:pid/stage/:play/view', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!enter(req, res)) return;
    res.type('html').send(await fs.readFile(path.join(DISPLAY_DIR, 'index.html'), 'utf8'));
  } catch (err) { next(err); }
});

router.get('/:pid/stage/:play/state', async (req, res, next) => {
  try {
    const play = enter(req, res); if (!play) return;
    const st = await stageState(req.params.pid, play);
    if (!st) return res.status(404).json({ error: 'no such play' });
    res.json(st);
  } catch (err) { next(err); }
});

/** SSE：先整份快照（hello），之后跟事件。nginx 前面要 X-Accel-Buffering: no。 */
router.get('/:pid/stage/:play/events', async (req, res) => {
  const play = enter(req, res); if (!play) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': stage\n\n');
  const off = await subscribeStage(req.params.pid, play, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25_000);
  req.on('close', () => { clearInterval(ping); off(); });
});

router.post('/:pid/stage/:play/say', express.json({ limit: '64kb' }), async (req, res) => {
  const play = enter(req, res); if (!play) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 8000) return res.status(400).json({ error: 'text too long' });
  try { res.json({ ok: true, ...(await sayToStage(req.params.pid, play, text, { userId: req.user?.id || null, check: req.body?.check && typeof req.body.check === 'object' ? req.body.check : null })) }); } catch (err) { sendErr(res, err); }
});

/**
 * 起进程 / 重开。正路是玩家在显示器里点「开始」或说话；这里给用户手动起，和带配置的直建
 * （body 给 table / cast / rules —— 站主自己调试用，前端不暴露）。
 */
router.post('/:pid/stage/:play/start', express.json({ limit: '256kb' }), wrap(async (req, play) => {
  const b = req.body || {};
  let root = play;
  if (b.table || b.cast || b.rules) root = await createPlay(req.params.pid, { title: b.title || play, table: b.table, cast: b.cast, vitals: b.vitals, skin: b.skin, rules: b.rules, model: b.model, style: b.style });
  return startStage(req.params.pid, root);
}));
router.post('/:pid/stage/:play/stop', wrap((req, play) => stopStage(req.params.pid, play, 'user')));
router.patch('/:pid/stage/:play/config', express.json({ limit: '256kb' }), wrap((req, play) => patchStageConfig(req.params.pid, play, req.body || {})));
/** 用户在状态页拨值：{ "好感": 60 } */
router.post('/:pid/stage/:play/state', express.json({ limit: '16kb' }), wrap((req, play) => setUserState(req.params.pid, play, req.body || {})));

// ── 开场 / 预设 ──
router.post('/:pid/stage/:play/open', express.json({ limit: '64kb' }), wrap((req, play) => openStory(req.params.pid, play, { style: req.body?.style || null, lore: req.body?.lore || null, cardOptions: req.body?.cardOptions || null, userId: req.user?.id || null })));
/** 世界书的触发条目清单（名字 + 触发词），开场页 / 设定页画成开关；常驻条目不在这里（那些在设定里） */
router.get('/:pid/stage/:play/lore', wrap(async (req, play) => ({ entries: (await loadWorldbook(runtimeOf(req.params.pid, play).playAbs)).map(({ name, rel, keys }) => ({ name, rel, keys })) })));
router.get('/:pid/stage/:play/presets', wrap(async (req, play) => ({ presets: await listPresets(runtimeOf(req.params.pid, play).playAbs) })));
router.post('/:pid/stage/:play/preset', express.json({ limit: '8mb' }), wrap((req, play) => uploadPreset(req.params.pid, play, { name: req.body?.name, data: req.body?.data })));

// ── 面板：玩家在显示器里买 / 用 / 装上（跟演出进程的 update_panel 同一条账）──
router.post('/:pid/stage/:play/panel', express.json({ limit: '16kb' }), wrap(async (req, play) => {
  const r = await panelOp(req.params.pid, play, req.body || {}, { by: 'player' });
  if (!r) throw Object.assign(new Error('这个故事没有面板'), { status: 404 });
  if (r.error) throw Object.assign(new Error(r.error), { status: 400 });
  return { ok: true, change: r.change, panels: r.panels };
}));

// ── 线路 ──
router.get('/:pid/stage/:play/lines', wrap(async (req, play) => ({ lines: await listLines(req.params.pid, play) })));
router.post('/:pid/stage/:play/rewind', express.json({ limit: '4kb' }), wrap((req, play) => rewindTo(req.params.pid, play, String(req.body?.rowId || ''))));
router.post('/:pid/stage/:play/fork', express.json({ limit: '4kb' }), wrap((req, play) => forkAt(req.params.pid, play, String(req.body?.rowId || ''), { name: req.body?.name })));
router.post('/:pid/stage/:play/line', express.json({ limit: '4kb' }), wrap((req, play) => switchLine(req.params.pid, play, String(req.body?.id || ''))));
router.patch('/:pid/stage/:play/line', express.json({ limit: '4kb' }), wrap((req, play) => renameLine(req.params.pid, play, String(req.body?.id || ''), req.body?.name)));
router.delete('/:pid/stage/:play/line', wrap((req, play) => deleteLine(req.params.pid, play, String(req.query.id || ''))));

// ── 文件 ──
router.get('/:pid/stage/:play/files', wrap(async (req, play) => ({ files: await listStageFiles(req.params.pid, play) })));
router.get('/:pid/stage/:play/file', wrap((req, play) => readStageFile(req.params.pid, play, String(req.query.path || ''))));
/** 改设定 / 规则 / 角色卡 / 世界书 / 预设 / 记忆正文。角色卡的机器块服务端保住；改完下一句话到时进程自己重开。 */
router.put('/:pid/stage/:play/file', express.json({ limit: '512kb' }), wrap((req, play) => saveStageFile(req.params.pid, play, String(req.body?.path || ''), String(req.body?.text ?? ''))));
router.delete('/:pid/stage/:play/memory', express.json({ limit: '4kb' }), wrap((req, play) => deleteMemory(req.params.pid, play, { name: String(req.query.name || req.body?.name || ''), who: req.query.who || req.body?.who || null })));
router.get('/:pid/stage/:play/images', wrap(async (req, play) => ({ images: await listStageImages(req.params.pid, play) })));

export default router;
