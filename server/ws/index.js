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

    // ?since=N — 客户端最后看到的 EventBus seq；server 通过 buffer 回放 (since, _seq] 段
    // 第一次连不带 since → since=0 → 不 replay 直接 live。
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw != null ? Math.max(0, parseInt(sinceRaw, 10) || 0) : 0;

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleProjectWS(ws, pid, since);
    });
  });

  return wss;
}

function handleProjectWS(ws, pid, since = 0) {
  const bus = getProjectBus(pid);

  // subscribeFromSeq 同步先 replay buffer 里 seq > since 的，然后切 live。
  // listener 抛错被 EventBus 内部吞 + warn —— ws.send 失败也只是 warn 不抛，避免影响别人。
  const { unsubscribe, replayed, gap } = bus.subscribeFromSeq(since, (event) => {
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

  // 确认 + replay 元信息（gap=true 客户端可决定全量 hydrate）。
  // 故意放在 replay 之后发：客户端看到 ws.connected 就知道 backlog 已 drain，可切回正常 live 状态。
  try {
    ws.send(JSON.stringify({
      type: 'ws.connected',
      projectId: pid,
      ts: new Date().toISOString(),
      since,
      replayed,
      gap,
    }));
  } catch { /* immediate close edge */ }
}
