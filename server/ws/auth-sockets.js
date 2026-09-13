/**
 * server/ws/auth-sockets.js — 已建立的 WebSocket 按账号登记，吊销登录时主动断开
 *
 * WS 只在 upgrade 那一刻验身份。会话被吊销（退出登录、找回密码、「退出所有其他设备」、账号停用）之后，
 * 已经连着的 socket 不会自己失效，其中浏览器共视通道还能注入键鼠。所以两条升级路（ws/index.js、
 * ws/browse-channel.js）建连后在这里登记，hosted 吊销会话时调 closeUserSockets。
 *
 * 关闭码用 4401：前端 ws-client 把它列为 fatal，停止重连并回登录页。
 */

/** userId → Set<{ ws, sessionId }> */
const byUser = new Map();

/**
 * @param {import('ws').WebSocket} ws
 * @param {{ user: { id: string }, sessionId: string|null }} auth  session.requestAuth 的结果
 */
export function trackSocket(ws, auth) {
  const userId = auth?.user?.id;
  if (!userId) return;
  const entry = { ws, sessionId: auth.sessionId ?? null };
  let set = byUser.get(userId);
  if (!set) byUser.set(userId, (set = new Set()));
  set.add(entry);
  ws.once('close', () => {
    set.delete(entry);
    if (set.size === 0 && byUser.get(userId) === set) byUser.delete(userId);
  });
}

/**
 * 断开某账号的连接。
 * @param {string} userId
 * @param {{ sessionId?: string, exceptSessionId?: string }} [opts]
 *   sessionId：只断这一个会话建的连接；exceptSessionId：保留这一个会话的，其余全断；都不给：全断
 * @returns {number} 断开的数量
 */
export function closeUserSockets(userId, { sessionId, exceptSessionId } = {}) {
  const set = byUser.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const entry of [...set]) {
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
    if (exceptSessionId !== undefined && entry.sessionId === exceptSessionId) continue;
    try { entry.ws.close(4401, 'unauthorized'); } catch { /* 已经在关 */ }
    set.delete(entry);
    n += 1;
  }
  if (set.size === 0) byUser.delete(userId);
  return n;
}

/** 测试用 */
export function _socketCount(userId) {
  return byUser.get(userId)?.size ?? 0;
}
