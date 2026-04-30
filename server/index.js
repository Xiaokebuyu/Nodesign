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

import http from 'http';
import express from 'express';
import cors from 'cors';

import { setupWS } from './ws/index.js';

const PORT = Number(process.env.PORT || 4001);

const app = express();

app.use(cors({ origin: true, credentials: true }));
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

// ── 业务路由（C3 起补齐，目前都是 501）──
const notImplemented = (_req, res) => res.status(501).json({ error: 'C3+ implements' });
app.use('/api/projects', notImplemented);
app.use('/api/skills', notImplemented);

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

httpServer.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] health: http://localhost:${PORT}/api/health`);
});

// graceful shutdown
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);
  httpServer.close((err) => {
    if (err) console.error('[server] close error:', err);
    process.exit(err ? 1 : 0);
  });
  // 兜底强制退出
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
