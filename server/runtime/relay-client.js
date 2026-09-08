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
import { noteRelayCall } from '../lib/diag-events.js';

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

/** 站点地址归一（剥尾斜杠；空 = 官方站） */
export function normalizeRelayUrl(url) {
  return String(url || DEFAULT_RELAY_URL).trim().replace(/\/+$/, '') || DEFAULT_RELAY_URL;
}

async function call(pathname, { method = 'GET', body = null, raw = null, form = null, responseType = 'json', timeoutMs = FETCH_TIMEOUT_MS, auth = true, url = null, headers: extraHeaders = null } = {}) {
  const cfg = relayConfig();
  if (auth && !cfg) throw Object.assign(new Error('relay 未配置（缺少 NODESIGN_RELAY_TOKEN）'), { code: 'RELAY_NOT_CONFIGURED' });
  // 没令牌的路（首启登录）cfg 是 null：地址按 传入 > .env > 官方站 取
  const base = normalizeRelayUrl(url || cfg?.url || process.env.NODESIGN_RELAY_URL);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const sentAt = Date.now();
  let headAt = null;
  const account = (status, error = null) => noteRelayCall({ path: pathname, method, status, error, headMs: headAt ? headAt - sentAt : null, totalMs: Date.now() - sentAt });
  try {
    const res = await fetch(`${base}/api/relay${pathname}`, {
      method,
      // raw = { buf, contentType }：二进制原样发（头像上传）；form = FormData（市场发布，fetch 自己写 boundary）；body 走 JSON
      // ⛔ 不复用连接（09-08）：本机代理（fake-ip TUN）下半开的 keep-alive 连接会让下一发挂到超时，
      //   站点这头什么都没收到。每发一次握手多 100~300ms，换来的是不会白等 8~60 秒。
      headers: { connection: 'close', ...(auth ? { authorization: `Bearer ${cfg.token}` } : {}), ...(raw ? { 'content-type': raw.contentType } : body ? { 'content-type': 'application/json' } : {}), ...(extraHeaders || {}) },
      body: raw ? raw.buf : form ? form : body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    headAt = Date.now();
    // responseType 'buffer'：二进制响应（skill 下载 / 参考图）。出错时服务端仍回 JSON，照常解错
    if (responseType === 'buffer' && res.ok) {
      return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'application/octet-stream', headers: res.headers };
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（nginx 的 502 页之类） */ }
    account(res.status);
    if (!res.ok) {
      const message = json?.error?.message || json?.error || `HTTP ${res.status}`;
      throw Object.assign(new Error(message), { status: res.status, code: json?.code || `HTTP_${res.status}`, quota: json?.quota || null, body: json });
    }
    return json;
  } catch (err) {
    if (!headAt) account(null, err.name === 'AbortError' ? 'timeout' : (err.code || err.message));
    if (err.name === 'AbortError') throw Object.assign(new Error(`relay ${base} 在 ${timeoutMs / 1000}s 内无响应`), { code: 'RELAY_TIMEOUT' });
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
/**
 * 开会话：8 秒超时或连接层失败就**换一条新连接再打一次**。09-08 站主桌面两次「RELAY_TIMEOUT：8s 内无响应」，
 * 站点 nginx 在那两个时刻连 499 都没有 —— 请求根本没到，是本机到 Cloudflare 的连接偶发停顿（代理侧半开连接）。
 * 紧接着的重试都是秒回，所以这里自己重试一次，带 connection: close 绕开可能坏掉的连接池。幂等：服务端按 sid 去重。
 */
export async function openRelaySession(sid, appModel) {
  try {
    return await call('/sessions', { method: 'POST', body: { sid, appModel } });
  } catch (err) {
    if (err.code !== 'RELAY_TIMEOUT' && !/fetch failed/i.test(String(err.message))) throw err;
    console.warn(`[relay-client] open session ${String(sid).slice(0, 8)} 第一发 ${err.code || err.message}，换连接重试一次`);
    return call('/sessions', { method: 'POST', body: { sid, appModel }, headers: { connection: 'close' } });
  }
}

/** 结束后注销。失败只记日志：服务器有空闲清扫兜底，注销失败不该影响收尾 */
export async function closeRelaySession(sid) {
  try { await call(`/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }); }
  catch (err) { console.warn(`[relay-client] 注销会话 ${String(sid).slice(0, 8)} 失败：${err.message}`); }
}

// ── 登录 / 退出（桌面版首启那道门；账号密码只经手一次，换回来的是设备令牌） ──

/**
 * 账号密码换设备令牌。不需要已有令牌（auth:false）；站点地址可指定（默认官方站）。
 * 只做网络这一步：写 .env、刷目录是 api/local.js 的事。失败抛错带 code（BAD_CREDENTIALS / RATE_LIMITED / TOO_MANY_DEVICES / RELAY_TIMEOUT）。
 * @returns {Promise<{ token: string, device: object, user: object }>}
 */
export async function relayLogin({ url = null, username, password, label }) {
  return call('/login', { method: 'POST', auth: false, url, body: { username, password, label } });
}

/** 站内公告 + 当前额度（桌面版横幅 60s 一拉） */
export async function relayNotice() { return call('/notice'); }

/** 头像：原图二进制上传，站点缩好存；回 { ok, avatar: dataUrl }。成功后调用方刷目录让 whoami 带上新图 */
export async function relayPutAvatar(buf, contentType) { return call('/avatar', { method: 'PUT', raw: { buf, contentType } }); }
export async function relayDeleteAvatar() { return call('/avatar', { method: 'DELETE' }); }

/** 吊销当前这枚令牌。失败只记日志：令牌本地反正要清，服务器那头留着一枚吊不掉的也只是列表里多一行 */
export async function relayLogout() {
  try { await call('/logout', { method: 'POST' }); return true; }
  catch (err) { console.warn(`[relay-client] 退出登录时吊销令牌失败：${err.message}`); return false; }
}

/** 站点账本里这个账号近 N 天的日序列（设置页「用量」）。失败抛错，调用方自己决定怎么显示 */
export async function relayUsageDaily(days = 30) {
  return call(`/usage/daily?days=${encodeURIComponent(days)}`);
}

// ── 工具中继（09-07）：桌面版没有站主的钥匙，联网搜索 / 生图这类调用交给网关用站主的钥匙跑 ──

/** 目录里 /whoami 报的"网关替你跑的工具"：{ web_search: bool, generate_image: bool }；目录没拉到 = 全 false */
/** whoami 带回的「装过但已被站点撤回」的发布 id；目录没拉到 = 空集（宁可多加载也别把人家正常的 skill 静默藏掉） */
export function relayRevokedPublicationIds() {
  const ids = catalog.ok ? catalog.whoami?.market?.revoked : null;
  return new Set(Array.isArray(ids) ? ids : []);
}

export function relayTools() {
  return catalog.ok && catalog.whoami?.tools && typeof catalog.whoami.tools === 'object' ? catalog.whoami.tools : {};
}

/**
 * 调网关上的一件工具。失败抛错带 code（TIER_DENIED / QUOTA_EXCEEDED / RELAY_TIMEOUT …），
 * 调用方把 message 原样给 agent。生图要等几十秒，超时单独给。
 */
/**
 * 工具代打（web_search 等）：09-08 站主一轮里 web_search 等了 60 秒才超时。连接停顿是本机到 Cloudflare 的事，
 * 站点这头秒回，所以等 60 秒没意义：首发 20 秒、换连接再来一次 20 秒；真慢的搜索（网关代搜一般 3~8 秒）够用。
 */
export async function relayToolCall(name, body, { timeoutMs = 20_000 } = {}) {
  const p = `/tools/${encodeURIComponent(name)}`;
  try {
    return await call(p, { method: 'POST', body, timeoutMs });
  } catch (err) {
    if (err.code !== 'RELAY_TIMEOUT' && !/fetch failed/i.test(String(err.message))) throw err;
    console.warn(`[relay-client] tool ${name} 第一发 ${err.code || err.message}，换连接重试一次`);
    return call(p, { method: 'POST', body, timeoutMs, headers: { connection: 'close' } });
  }
}

/** 上报一条到站点 issues 表（hosted/relay/issues.js）。调用方是 runtime/issue-outbox.js，失败它自己排队 */
export async function relayReportIssue(item) {
  return call('/issues', { method: 'POST', body: item, timeoutMs: 15_000 });
}

// ── skill 市场（09-08）：桌面版的货架和发布都在站点上，本机只做打包 / 落盘 ──

export async function relayMarketList() { return call('/market'); }
export async function relayMarketMine() { return call('/market/mine'); }
export async function relayMarketFeatured() { return call('/market/featured'); }
export async function relayMarketGet(id) { return call(`/market/${encodeURIComponent(id)}`); }
/** @returns {Promise<{ buffer: Buffer, contentType: string }>} */
export async function relayMarketImage(id, n) { return call(`/market/${encodeURIComponent(id)}/images/${Number(n)}`, { responseType: 'buffer', timeoutMs: 20_000 }); }
/** 发布：form 是 FormData（title / note / skill 文件 / images[]）。站点校验要解 zip、缩图，给 60s */
export async function relayMarketPublish(form) { return call('/market', { method: 'POST', form, timeoutMs: 60_000 }); }
export async function relayMarketWithdraw(id) { return call(`/market/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
/** skill 原字节回来本机装；响应头 X-ND-Skill-Sha256 是站点记的哈希 */
export async function relayMarketDownload(id) { return call(`/market/${encodeURIComponent(id)}/download`, { responseType: 'buffer', timeoutMs: 30_000 }); }
export async function relayMarketInstalled(id) { return call(`/market/${encodeURIComponent(id)}/installed`, { method: 'POST' }); }
