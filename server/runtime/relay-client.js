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
let catalog = { configured: false, ok: false, at: 0, error: null, whoami: null, models: [], renames: {} };

export function relayCatalog() { return catalog; }

/** 目录里的一行；不在目录 = null */
export function relayModelEntry(appModel) {
  return catalog.ok ? (catalog.models.find((m) => m.id === appModel) || null) : null;
}

// 目录换了一份就通知（model-context 据此重建模型表：09-11 起本机没钥匙的行是照目录建的）。
// 用订阅而不是在这里 import model-context：那边已经 import 这个文件，反过来就成环了
const listeners = new Set();
export function onRelayCatalogChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setCatalog(next) {
  catalog = next;
  for (const fn of listeners) { try { fn(catalog); } catch (err) { console.warn(`[relay-client] 目录变更回调失败：${err.message}`); } }
}

// 目录原样存（含锁）。「按钟点关门」那一种锁要不要照搬，按行判：照目录建的行带着站点实际生效的时段，本机会现算；
// 不是照目录建的行照旧信站点 —— 判据在 model-context.selectableModelsFor，这里不摘（09-11 评审：摘早了会让关门时段漏过去）
let refreshSeq = 0;   // 并发刷新只认最后开始的那次（老令牌的定时刷新晚回来，不许盖掉退出 / 换号之后的目录）

/**
 * 拉 /whoami 与 /models。失败不抛：目录标成 ok:false 带 error，选择器就当 relay 没有行；
 * 设置页把 error 显示出来。令牌无效（401）也是这一类 —— 用户填错令牌不该让服务端起不来。
 *
 * keepOnError（后台定时刷新用）：失败时**保留上一份拉到的目录**。目录里的行 09-11 起是桌面模型表的一部分，
 * 网络抖一下 / 站点 5xx / 429 / Cloudflare 质询就让它们消失，选择器会空、下一句话会被拦。
 * 只有**令牌失效**（401 / DEVICE_TOKEN_INVALID）照常换掉：那时目录本来就不该再用。
 */
export async function refreshRelayCatalog({ keepOnError = false } = {}) {
  const seq = ++refreshSeq;
  const cfg = relayConfig();
  if (!cfg) { setCatalog({ configured: false, ok: false, at: Date.now(), error: null, whoami: null, models: [], renames: {} }); return catalog; }
  try {
    const [whoami, models] = await Promise.all([call('/whoami'), call('/models')]);
    if (seq !== refreshSeq) return catalog;   // 这期间又开始了一次刷新（登录 / 退出 / 手动刷新）：以那次为准
    const list = Array.isArray(models?.models) ? models.models : [];
    const renames = models?.renames && typeof models.renames === 'object' ? models.renames : {};
    setCatalog({ configured: true, ok: true, at: Date.now(), error: null, whoami, models: list, renames });
  } catch (err) {
    if (seq !== refreshSeq) return catalog;
    const error = `${err.code ? err.code + ': ' : ''}${err.message}`;
    const tokenDead = err.status === 401 || err.code === 'DEVICE_TOKEN_INVALID';
    if (keepOnError && catalog.ok && !tokenDead) {
      console.warn(`[relay-client] 定时刷新目录失败，沿用上一份（${cfg.url}）：${error}`);
      return catalog;
    }
    setCatalog({ configured: true, ok: false, at: Date.now(), error, whoami: null, models: [], renames: {} });
    console.warn(`[relay-client] 拉不到 relay 目录（${cfg.url}）：${catalog.error}`);
  }
  return catalog;
}

/** 后台定时重拉目录：站点加的行、改的名字桌面不重启就能看到（09-11）。只在本地版起动时调一次 */
let refreshTimer = null;
export function startRelayCatalogRefresh(everyMs = 10 * 60 * 1000) {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { refreshRelayCatalog({ keepOnError: true }).catch(() => {}); }, everyMs);
  refreshTimer.unref();
}

/** 测试用：直接塞一份目录（照样通知，模型表跟着重建） */
export function _setRelayCatalog(c) { setCatalog({ renames: {}, ...c }); }

// ── 会话 ──

/** 起 query 前登记。失败抛错（带 code：SUBSCRIPTION_REQUIRED / DEVICE_TOKEN_INVALID / RELAY_TIMEOUT …），让 init 失败得有话说 */
/**
 * 开会话：8 秒超时或连接层失败就**换一条新连接再打一次**。09-08 站主桌面两次「RELAY_TIMEOUT：8s 内无响应」，
 * 站点 nginx 在那两个时刻连 499 都没有 —— 请求根本没到，是本机到 Cloudflare 的连接偶发停顿（代理侧半开连接）。
 * 紧接着的重试都是秒回，所以这里自己重试一次，带 connection: close 绕开可能坏掉的连接池。幂等：服务端按 sid 去重。
 */
export async function openRelaySession(sid, appModel) {
  const gen = ++genSeq;
  relayGens.set(sid, gen);   // 先占代次：旧 query 的注销晚到时看见代次变了，就不发那条会删掉本次登记的 DELETE
  const pending = closing.get(sid);
  if (pending) await pending;   // 旧的注销已经发出去了：等它落地再登记，别让它后到站点把新登记删了
  let r;
  try {
    try {
      r = await call('/sessions', { method: 'POST', body: { sid, appModel } });
    } catch (err) {
      if (err.code !== 'RELAY_TIMEOUT' && !/fetch failed/i.test(String(err.message))) throw err;
      console.warn(`[relay-client] open session ${String(sid).slice(0, 8)} 第一发 ${err.code || err.message}，换连接重试一次`);
      r = await call('/sessions', { method: 'POST', body: { sid, appModel }, headers: { connection: 'close' } });
    }
  } catch (err) {
    if (relayGens.get(sid) === gen) relayGens.delete(sid);   // 没登记上：代次不留（留着的话同 sid 旧登记的注销会被它挡掉）
    throw err;
  }
  return { ...r, gen };
}

/**
 * 同一个 sid 的登记代次（09-11 验收抓到的竞态）。会话中途换模型会拿**同一个 sid** 重启 query：
 * 新 query 起动时 POST 登记，旧 query 的 finally 稍后才 DELETE 注销（closeQuerySession 只是标记关闭）。
 * 两条请求各走各的连接，到站点的先后不保证 —— DELETE 后到就把新登记删了，新 query 第一发 400「会话没登记」。
 * 所以注销带着**自己那次登记的代次**来：这个 sid 已经有更新的登记就不发。
 */
const relayGens = new Map();   // sid → 本机最近一次登记的代次
const closing = new Map();     // sid → 在路上的那条 DELETE
let genSeq = 0;

/**
 * 结束后注销。失败只记日志：服务器有空闲清扫兜底，注销失败不该影响收尾。
 * @param {string} sid
 * @param {number|null} [gen]  openRelaySession 给的代次；不传 = 不比代次直接注销（老调用方）
 */
export async function closeRelaySession(sid, gen = null) {
  if (gen != null && relayGens.get(sid) !== gen) return;   // 同 sid 已经重新登记过：这条注销会删掉新的，不发
  relayGens.delete(sid);
  const p = call(`/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' })
    .catch((err) => { console.warn(`[relay-client] 注销会话 ${String(sid).slice(0, 8)} 失败：${err.message}`); });
  closing.set(sid, p);
  try { await p; } finally { if (closing.get(sid) === p) closing.delete(sid); }
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
