/**
 * web/src/lib/ws-client.js — WebSocket 客户端，含指数退避重连 + replay-on-reconnect
 *
 * 用法：
 *   const ws = openProjectWS({ projectId, onEvent, onClose? });
 *   ws.close();   // 停止重连 + 关闭连接
 *
 * 行为：
 *   - 自动连 ws://<host>/ws/projects/:pid（重连时拼 ?since=<lastSeq>）
 *   - 收到 message → JSON.parse → onEvent(evt)；event.seq 单调递增 → 更新 lastSeq
 *   - close → 等 backoff 重连（1s → 2s → ... → 30s 上限）
 *   - 4xx/服务认为不该重连的 close code → 停止
 *   - 调用方 close() → 立即停止 + 不再重连
 *
 * Replay 机制（2026-05-03 加）：
 *   server EventBus 维护 ring buffer (2000 条)；首次连不带 since → live。重连时拼
 *   ?since=lastSeq → server 同步 replay buffer 里 seq > since 的事件再切 live。
 *   ws.connected 帧带 { since, replayed, gap }；gap=true 表示中间被挤掉一段，
 *   客户端可据此决定要不要全量 hydrate（当前 ProjectWorkspace mount 时已经 hydrate 一次，
 *   gap 警告作为日志先打 console）。
 */

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

// WebSocket close codes 不应该重连的（真错误，不是网络断）
const FATAL_CLOSE_CODES = new Set([
  1008, // policy violation（含 server 主动拒）
  1011, // server error
  4404, // 自定义：project not found（如果将来 server 用 4xxx 段）
]);

export function openProjectWS({ projectId, onEvent, onClose }) {
  let ws = null;
  let reconnectTimer = null;
  let backoff = MIN_BACKOFF_MS;
  let stopped = false;
  /** 最后一条收到的事件 seq；重连时拼 ?since= 用 */
  let lastSeq = 0;

  function buildUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const base = `${proto}://${window.location.host}/ws/projects/${encodeURIComponent(projectId)}`;
    return lastSeq > 0 ? `${base}?since=${lastSeq}` : base;
  }

  function connect() {
    if (stopped) return;

    try {
      ws = new WebSocket(buildUrl());
    } catch (err) {
      console.warn('[ws] WebSocket ctor threw:', err.message);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = MIN_BACKOFF_MS;
    };

    ws.onmessage = (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }
      // 更新 lastSeq —— EventBus 单调 seq；ws.connected 没 seq 不动。
      // gap=true 时打 warn，方便日后排查丢事件场景。
      if (typeof data.seq === 'number' && data.seq > lastSeq) {
        lastSeq = data.seq;
      } else if (data.type === 'ws.connected' && data.gap) {
        console.warn(`[ws] replay gap detected (since=${data.since}, replayed=${data.replayed}); some events may be missing — refresh if state looks wrong`);
      }
      try {
        onEvent?.(data);
      } catch (err) {
        console.warn('[ws] onEvent threw:', err);
      }
    };

    ws.onclose = (e) => {
      ws = null;
      try { onClose?.(e); } catch { /* ignore */ }
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(e.code)) {
        // 永久错误 — 不重连
        stopped = true;
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      // onclose 会跟进；这里不重复重连
      console.warn('[ws] error:', err?.message || 'unknown');
    };
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      connect();
    }, backoff);
  }

  connect();

  return {
    close() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    },
  };
}
