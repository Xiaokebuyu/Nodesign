/**
 * server/index.js — NoDesign 后端入口
 *
 * 职责：
 *   - Express HTTP 服务（默认端口 4001）
 *   - WebSocket upgrade 处理（路径 /ws/projects/:pid）
 *   - 路由挂载（/api/* — 业务 endpoint 在 C3+ 逐步补齐）
 *   - dev 环境 CORS 开放给 vite 5174（prod 走 vite proxy 同源不需要）
 *
 * 启动：
 *   node --env-file-if-exists=.env server/index.js
 *   （Node 22+ 内置 --env-file-if-exists，不需要 dotenv 依赖）
 */

// ⚠️ 必须是第一个 import：它在别的模块加载前决定 profile（hosted | local）并给数据目录 env 填默认值
import './runtime/profile.js';
import http from 'http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { originAllowed } from './auth/origin-guard.js';

import { setupWS } from './ws/index.js';
import { primeOwnAddresses } from './lib/ssrf-guard.js';
import { stopIngress } from './lib/model-ingress.js';
import { stopAllStages } from './engine/stage/manager.js';
import { startRembgService, stopRembgService } from './services/rembg-launcher.js';
import projectsRouter from './api/projects.js';
import canvasRouter from './api/canvas.js';
import skillsRouter from './api/skills.js';
import assetsRouter from './api/assets.js';
import turnRouter from './api/turn.js';
import exportsRouter from './api/exports.js';
import sessionsRouter from './api/sessions.js';
import instructionRouter from './api/instruction.js';
import boardRouter from './api/board.js';
import stageRouter from './api/stage.js';
import pendingChangesRouter from './api/pending-changes.js';
import browseRouter from './api/browse.js';
import publishRouter from './api/publish.js';
import chataiRouter from './api/chatai.js';
import recentRouter from './api/recent.js';
import { userPluginsRouter, projectPluginsRouter } from './api/plugins.js';
import { authRouter, authGuard } from './auth/middleware.js';
import { authEnabled } from './auth/session.js';
import { bootstrapAuth } from './auth/users-store.js';
import { sweepOrphanRuns } from './engine/runs/store.js';
import meRouter from './api/me.js';
import localRouter, { RESTART_EXIT_CODE } from './api/local.js';
import { platform } from './runtime/platform.js';
import { refreshRelayCatalog } from './runtime/relay-client.js';
import { probeCapabilities, summarizeCapabilities } from './runtime/capabilities.js';

// 启动时 dump 平台决策（让运维一眼看到 OS / HOME / claudeConfigDir / sandbox / preflight）
// 跨平台坑排查的第一信号
platform.dump();
// 本机能力位（git / chromium / LibreOffice / 钥匙…）：启动探一遍，工具注册（mcp/capability-gate.js）与
// GET /api/local/status 都读它。探测是异步的（playwright 要 import），在 listen 之前等它
await probeCapabilities();
console.log(summarizeCapabilities());

const PORT = Number(process.env.PORT || 4001);

const app = express();

// cors：origin:true 是「反射任何来源」，配 credentials 等于把 REST 也交给同站
// 攻击面（见 auth/origin-guard.js）。收成同一份判据。
app.use(cors((req, cb) => cb(null, {
  origin: originAllowed(req) ? (req.headers.origin || true) : false,
  credentials: true,
})));
// hosted 外环（relay / 管理台）只在 hosted 起，而且是**动态** import：本地分发版的包里根本没有
// server/hosted/（见 server/scripts/check-client-boundary.mjs），顶部静态 import 会让客户端崩在解析阶段。
// relay 必须挂在 express.json 之前（它要原始 body），所以在这儿就得把模块拿到手。
const hosted = platform.isLocal ? null : await import('./hosted/mount.js');
hosted?.mountHostedEarly(app);
app.use(express.json({ limit: '4mb' }));

// ── Health ──
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'nodesign',
    version: '0.1.0',
    ts: new Date().toISOString(),
  });
});

// ── 登录墙（health 之后、业务路由之前）──
// 多用户 bootstrap（幂等）：users 空时用 NODESIGN_AUTH_PASSWORD 建 admin +
// 回填存量项目归属。必须在 authEnabled() 判断之前跑
// 僵尸 run 清扫：只有 server 启动时才知道"上个进程已经死了"这个前提成立。
// 2026-07-31 从 store.js 的模块加载副作用挪到这里 —— 挂在 import 上时，任何
// 碰到 store 的脚本（invite.mjs / notice.mjs / 临时排查）都会把线上正在跑的
// run 全标成 failed，实测误杀过真实用户的对话。
sweepOrphanRuns();

if (platform.isLocal) {
  // 本地分发版：单租户，登录墙钉死关闭（auth/users-store.js authEnabled），请求者恒为 LOCAL_OWNER。
  // 不跑 bootstrapAuth：它会按 NODESIGN_AUTH_PASSWORD 建 admin、回填项目归属 —— 那是多用户站的事。
  console.log(`[profile] local：单租户模式，数据目录 ${platform.dataRoot}，只监听 ${platform.listenHost}`);
  // 站主 relay 的目录（配了令牌才拉；没配 / 拉不到都不阻止起动，选择器就只剩本机钥匙的行）
  const relay = await refreshRelayCatalog();
  if (relay.configured) console.log(relay.ok ? `[relay-client] ${relay.whoami?.user?.username}（${relay.whoami?.user?.tier}）· 站点提供 ${relay.models.length} 个模型` : `[relay-client] ⚠️ 站点目录拉不到：${relay.error}`);
} else {
  bootstrapAuth();
  if (!authEnabled()) {
    console.warn('[auth] ⚠️ 无用户且未设 NODESIGN_AUTH_PASSWORD — 登录墙关闭，切勿公网暴露！');
  }
}
app.use('/api/auth', authRouter);
app.use('/api', authGuard);
// admin 管理接口 + 当前用户自视图（都在 authGuard 之后，req.user 已挂）
if (hosted) await hosted.mountHostedLate(app);
app.use('/api/me', meRouter);
// 本地分发版专用（配置文件 / 状态 / 重启）。hosted 下不挂：这组接口假设请求者就是机器的主人
if (platform.isLocal) app.use('/api/local', localRouter);

// ── 业务路由 ──
// projects router 挂在 /api/projects（CRUD）
app.use('/api/projects', projectsRouter);
// canvas / assets / turn 共用 /api/projects/:pid/* 命名空间，挂同前缀
app.use('/api/projects', canvasRouter);
app.use('/api/projects', assetsRouter);
app.use('/api/projects', turnRouter);
app.use('/api/projects', exportsRouter);
app.use('/api/projects', sessionsRouter);
app.use('/api/projects', instructionRouter);
app.use('/api/projects', boardRouter);
app.use('/api/projects', stageRouter);        // 用户从画布对角色说的话落在画布上
app.use('/api/projects', pendingChangesRouter);  // C4: 用户直接编辑 + 评论 buffer
app.use('/api/projects', browseRouter);          // 刷新后拿回浏览器窗/求助状态
app.use('/api/projects', publishRouter);         // 站点一键上线 Cloudflare Pages
app.use('/api/projects', chataiRouter);          // 演出端点：页面 → chatai 通路（编排/闸门见 api/chatai.js）
app.use('/api/projects', projectPluginsRouter);  // 2026-05-18: project 级 plugin 上传/卸载/列表
// 跨项目聚合：/api/sessions/recent
app.use('/api', recentRouter);
// skills 全局
app.use('/api/skills', skillsRouter);
// 用户级 plugin（跨 project 全局）
app.use('/api/plugins', userPluginsRouter);

// ── 前端静态托管（本地分发版；hosted 由 nginx 发 dist，这里默认关）──
if (platform.serveWeb) {
  const indexHtml = path.join(platform.webDistDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    // 不抛：API 照常可用（开发者可能正用 vite dev 连着）。但要说出来，别让人对着 404 猜
    console.warn(`[server] ⚠️ 前端构建产物不存在：${indexHtml}（先 cd web && npm run build）`);
  }
  // 入口 HTML 不缓存（和线上 nginx 同口径：发新版后开着的页面刷新就能拿到新分片）；哈希分片随便缓存
  app.use(express.static(platform.webDistDir, {
    index: false,
    setHeaders(res, file) { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.use((req, res, next) => {
    // SPA 回退：非 API / WS 的 GET 一律回 index.html（/projects/:id 这类前端路由刷新不 404）
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
    if (!fs.existsSync(indexHtml)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}

// /api 下没路由接住的一律回 JSON 404（express 默认是 HTML，前端 jsonRequest 拿到的是解析错误不是 {error}）
app.use('/api', (req, res) => res.status(404).json({ error: `not found: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' }));

// ── 错误兜底 ──
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'internal error',
    code: err.code,
  });
});

// ── 启动 ──
const httpServer = http.createServer(app);
setupWS(httpServer);

// listenHost：local = 127.0.0.1（没有登录墙，绝不能开到全地址）；hosted = undefined（Node 默认全地址，nginx 在前）
httpServer.on('error', (err) => {
  // 不走 uncaughtException（那个 handler 故意不退出）：没监听成功的进程是僵尸，supervisor 会以为它还活着
  if (err?.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 已被占用（${platform.listenHost || '*'}:${PORT}）。换一个：nodesign --port 4002，或 PORT=4002；查占用：`
      + (process.platform === 'win32' ? `netstat -ano | findstr :${PORT}` : `lsof -i :${PORT}`));
  } else {
    console.error('[server] listen failed:', err?.message || err);
  }
  process.exit(1);
});
httpServer.listen(PORT, platform.listenHost, () => {
  // 出网闸要知道本机的公网 IP —— 云上 1:1 NAT 下它不在任何网卡上（见 ssrf-guard）
  primeOwnAddresses().catch(() => {});
  console.log(`[server] listening on ${platform.listenHost || ''}:${PORT}`);
  console.log(`[server] health: http://localhost:${PORT}/api/health`);
  if (platform.serveWeb) console.log(`[server] app: http://${platform.listenHost || 'localhost'}:${PORT}/`);
});

// 起 rembg-service 常驻 python 进程：onnxruntime session 在内存里 warm 缓存，
// 让 mcp__nodesign__remove_background 调用走 Unix socket（warm ~5-15s/张），
// 比 per-call cold spawn（~30-180s/张）快 10×。venv 不存在 / spawn 失败时
// noop 不阻塞 server，remove_background 走 fallback spawn-bridge 兼容路径。
// 详见 server/services/rembg-launcher.js + rembg-service.py。
startRembgService().catch((err) => {
  console.warn('[server] rembg-service start error (non-fatal):', err.message);
});

// 守护进程级兜底：SDK binary 子进程偶发 stdio 异常（write EPIPE 之类）会
// emit unhandled 'error' on Socket，nodejs 默认把整个 process 拉下水（之前
// 实测 "Session ID already in use" 错让 server crash 用户连不上）。
//
// 这里只 log + 不退出 —— 单次 SDK call 的 socket 错不该影响其他正在跑的
// session 或新 HTTP 请求。真严重的错（OOM / 不可恢复 state）会 log 后由
// 上层 watch / supervisord 重启。
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err?.message || err);
  if (err?.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason?.message || reason);
  if (reason?.stack) console.error(reason.stack);
});

// graceful shutdown
let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);
  // 关闭 model-ingress（API 通路会话会启的本地通用入口）。
  // 不阻塞 httpServer close —— close fail 也不影响主流程。
  // 台上的人先送走：演出进程是独立 SDK 子进程，不跟着主进程死，不停就是孤儿（各 300-500MB）
  stopAllStages(signal || 'shutdown').catch((err) => console.error('[server] stage close error:', err.message));
  stopIngress().catch((err) => console.error('[server] ingress close error:', err.message));
  // 关闭 rembg-service 常驻 python 进程（SIGTERM；兜底 3s 后 SIGKILL）。
  stopRembgService();
  httpServer.close((err) => {
    if (err) console.error('[server] close error:', err);
    process.exit(err ? 1 : exitCode);
  });
  // 兜底强制退出（重启请求也按约定码退，bin 的 supervisor 才会拉起新进程）
  setTimeout(() => process.exit(exitCode || 1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 本地分发版「保存配置后重启」：api/local.js 发这个事件，进程以 RESTART_EXIT_CODE 退出，bin/nodesign.js 的
// supervisor 见到这个码就重新拉起（模型表是加载时冻结的，热改不如重起干净）
process.on('nodesign:restart', () => shutdown('restart', RESTART_EXIT_CODE));
