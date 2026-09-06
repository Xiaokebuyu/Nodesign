/**
 * server/runtime/relay-client.js — 本地分发版连站主 relay 的那半（客户端侧）。
 *
 * ## 定位
 *
 * 桌面版 / npx 版默认走站主提供的推理服务（像 Cursor 那样），BYOK 是设置页里的第二选择。
 * 这个文件管三件事：配置（站点地址 + 设备令牌，都在 <dataRoot>/.env）、目录（relay 允许这个
 * 账号用哪些模型，起动和改钥匙时拉一次）、会话（起 query 前登记 sid，结束后注销）。
 *
 * ## 谁说了算
 *
 * 这里的一切都是**提示**，判决在服务器：目录只是让选择器别列出注定 403 的行；登记只是让
 * 服务器认得这个 sid。客户端报的模型、报的用量服务器都不信（server/hosted/relay/gates.js）。
 *
 * ## 与本地钥匙的优先级
 *
 * 同一行本机有钥匙（Claude 行 claude login 过 / 外部插槽填了 key）就走本机，否则看 relay 允不允许。
 * 见 model-context.modelSourceFor。
 *
 * 只在 local profile 有意义；hosted 下 relayConfig() 恒为 null，所有函数都是 noop。
 */

import { profile } from './profile.js';

/** 站主的站点。设置页可用 NODESIGN_RELAY_URL 覆盖（自建 hosted 实例、内网镜像） */
export const DEFAULT_RELAY_URL = 'https://nodesign.xiaobuyu.trade';

const FETCH_TIMEOUT_MS = 8000;

/** @returns {{ url: string, token: string } | null} 没令牌 = 没配 relay */
export function relayConfig() {
  if (!profile.isLocal) return null;
  const token = (process.env.NODESIGN_RELAY_TOKEN || '').trim();
  if (!token) return null;
  const url = (process.env.NODESIGN_RELAY_URL || DEFAULT_RELAY_URL).trim().replace(/\/+$/, '');
  return { url, token };
}

/** relay 端点：SDK 的 ANTHROPIC_BASE_URL 指这里（后面 SDK 自己接 /v1/messages） */
export function relayBaseUrlFor(sid) {
  const cfg = relayConfig();
  return cfg ? `${cfg.url}/api/relay/__nd/${encodeURIComponent(sid)}` : null;
}

async function call(pathname, { method = 'GET', body = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const cfg = relayConfig();
  if (!cfg) throw Object.assign(new Error('relay 没配（缺 NODESIGN_RELAY_TOKEN）'), { code: 'RELAY_NOT_CONFIGURED' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/api/relay${pathname}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（nginx 的 502 页之类） */ }
    if (!res.ok) {
      const message = json?.error?.message || json?.error || `HTTP ${res.status}`;
      throw Object.assign(new Error(message), { status: res.status, code: json?.code || `HTTP_${res.status}`, quota: json?.quota || null });
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error(`relay ${cfg.url} ${timeoutMs / 1000}s 没响应`), { code: 'RELAY_TIMEOUT' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── 目录：这个账号在 relay 上能用什么 ──
// 进程级缓存；起动、改钥匙、用户点"刷新"时重拉。选择器是同步读的（selectableModelsFor），
// 所以这里必须是同步可读的快照，网络在别处发生。
let catalog = { configured: false, ok: false, at: 0, error: null, whoami: null, models: [] };

export function relayCatalog() { return catalog; }

/** 目录里的一行；不在目录 = null */
export function relayModelEntry(appModel) {
  return catalog.ok ? (catalog.models.find((m) => m.id === appModel) || null) : null;
}

/**
 * 拉 /whoami 与 /models。失败不抛：目录标成 ok:false 带 error，选择器就当 relay 没有行；
 * 设置页把 error 显示出来。令牌无效（401）也是这一类 —— 用户填错令牌不该让服务端起不来。
 */
export async function refreshRelayCatalog() {
  const cfg = relayConfig();
  if (!cfg) { catalog = { configured: false, ok: false, at: Date.now(), error: null, whoami: null, models: [] }; return catalog; }
  try {
    const [whoami, models] = await Promise.all([call('/whoami'), call('/models')]);
    catalog = { configured: true, ok: true, at: Date.now(), error: null, whoami, models: Array.isArray(models?.models) ? models.models : [] };
  } catch (err) {
    catalog = { configured: true, ok: false, at: Date.now(), error: `${err.code ? err.code + ': ' : ''}${err.message}`, whoami: null, models: [] };
    console.warn(`[relay-client] 拉不到 relay 目录（${cfg.url}）：${catalog.error}`);
  }
  return catalog;
}

/** 测试用：直接塞一份目录 */
export function _setRelayCatalog(c) { catalog = c; }

// ── 会话 ──

/** 起 query 前登记。失败抛错（带 code：SUBSCRIPTION_REQUIRED / DEVICE_TOKEN_INVALID / RELAY_TIMEOUT …），让 init 失败得有话说 */
export async function openRelaySession(sid, appModel) {
  return call('/sessions', { method: 'POST', body: { sid, appModel } });
}

/** 结束后注销。失败只记日志：服务器有空闲清扫兜底，注销失败不该影响收尾 */
export async function closeRelaySession(sid) {
  try { await call(`/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }); }
  catch (err) { console.warn(`[relay-client] 注销会话 ${String(sid).slice(0, 8)} 失败：${err.message}`); }
}
