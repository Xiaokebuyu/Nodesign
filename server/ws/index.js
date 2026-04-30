/**
 * server/ws/index.js — WebSocket 升级入口
 *
 * URL 模式：/ws/projects/:pid
 *
 * 流程：
 *   1. http server 'upgrade' 事件触发
 *   2. parse URL 取 pid
 *   3. validateProjectId + getProject 校验存在
 *   4. wss.handleUpgrade → 拿到 ws 对象
 *   5. 订阅该 project 的 EventBus，事件 JSON.stringify 推 ws.send
 *   6. ping/pong 30s 心跳
 *   7. ws close → unsubscribe + clearInterval
 */

import { WebSocketServer } from 'ws';
import { URL } from 'url';
import { validateProjectId, getProject } from '../projects/store.js';
import { getProjectBus } from './broker.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export function setupWS(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://x');
    } catch {
      return socket.destroy();
    }

    const m = url.pathname.match(/^\/ws\/projects\/([^/]+)$/);
    if (!m) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }

    const pid = decodeURIComponent(m[1]);
    try {
      validateProjectId(pid);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }

    if (!getProject(pid)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleProjectWS(ws, pid);
    });
  });

  return wss;
}

function handleProjectWS(ws, pid) {
  const bus = getProjectBus(pid);

  const unsubscribe = bus.subscribe('*', (event) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(event));
      } catch (err) {
        console.warn(`[ws] send failed for ${pid}:`, err.message);
      }
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch { /* will close */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`[ws] error for ${pid}:`, err.message);
    cleanup();
  });

  // 连上时发一条确认（前端用来同步 hydrate 完成）
  try {
    ws.send(JSON.stringify({
      type: 'ws.connected',
      projectId: pid,
      ts: new Date().toISOString(),
    }));
  } catch { /* immediate close edge */ }
}
