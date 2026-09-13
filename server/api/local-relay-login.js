/**
 * server/api/local-relay-login.js — 本地版（桌面 / npx）登录站点账号：浏览器登录 + 令牌落盘 + 令牌失效收口（09-13 auth-v2 第四批）
 *
 * 挂在 /api/local/relay 下（api/local.js）：
 *
 *   POST   /browser-login          { url? } → { state, authorizeUrl }   发起「在浏览器中登录」；页面拿 authorizeUrl 开系统浏览器
 *   GET    /browser-login/:state   → { status: pending | done | superseded | cancelled | failed | expired, error }   页面每秒多问一次
 *                                   superseded = 别的一条等待先成功了（本机已经登录），页面照「完成」处理
 *   DELETE /browser-login/:state   页面上点「取消」→ { ok, busy, status }；busy 或已经 done / superseded = 取消晚了，页面接着等结果
 *   GET    /callback?code&state    站点确认页点「允许」后浏览器跳回这里（回一张小 HTML 页）
 *
 * 流程与站点侧见 hosted/auth/desktop-auth.js 头注。本机这半的几条规矩（方案 §5.7）：
 *   - state 与 PKCE verifier 只在本进程内存里，verifier 从不离开本机（站点只见过 challenge）
 *   - 回调 state 对不上：回「请求无效」页，**不动任何正在等待的登录**。本机端口谁都能访问，外站不能靠打一枪回调把登录打断
 *   - 同时可以有几条在等（用户点了两次、换了个浏览器），不互相顶掉；任何一条成功后其余作废
 *   - 授权码换令牌失败（码是假的 / 过期）不作废这条等待：真的那次跳转还可能在后面到。失败原因放进状态给页面显示
 *   - 发起口只收 application/json：跨站的简单请求（表单、no-cors fetch）过不来，外站刷不出一堆等待
 */

import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import { setEnvValues } from '../runtime/local-env.js';
import { refreshRelayCatalog, relayExchangeCode, relayConfig, relayLogout, clearRelayTokenInvalid, normalizeRelayUrl } from '../runtime/relay-client.js';
import { probeCapabilities } from '../runtime/capabilities.js';
import { msg } from '../shared/messages.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const FINISHED_KEEP_MS = 2 * 60 * 1000;   // 结束的条目留一会儿，页面轮询拿得到结果
const MAX_PENDING = 8;

/** state → { verifier, url, urlExplicit, createdAt, status, error, busy, finishedAt } */
const pendings = new Map();

function sweep(now = Date.now()) {
  for (const [k, p] of pendings) {
    if (p.status === 'pending' && now - p.createdAt > PENDING_TTL_MS) { p.status = 'expired'; p.finishedAt = now; }
    if (p.status !== 'pending' && now - (p.finishedAt || p.createdAt) > FINISHED_KEEP_MS) pendings.delete(k);
  }
}

/**
 * 两条登录路（账号密码 / 浏览器）共用的落盘：令牌进 .env、目录重拉、能力表重探。
 * url 只在用户明确指定了站点时写（没指定 = 沿用 .env 里已有的，可能是 exp），不是清掉。
 */
export async function applyRelayToken({ token, url = null }) {
  // 站点回的东西先验形状：自建 / 被冒充的站点回个怪值，别让它写进 .env（setEnvValues 遇到换行才会抛，别的都照写）
  if (typeof token !== 'string' || !/^ndk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw Object.assign(new Error('站点返回的设备令牌格式不对'), { code: 'BAD_RESPONSE' });
  }
  setEnvValues({ NODESIGN_RELAY_TOKEN: token, ...(url ? { NODESIGN_RELAY_URL: normalizeRelayUrl(url) } : {}) });
  clearRelayTokenInvalid();
  await refreshRelayCatalog();
  await probeCapabilities({ force: true });   // 登录后网关代跑的搜索 / 生图就"可用"了，引导页和工具闸都按这个
}

/**
 * 站点判定本机令牌失效（relay-client 的 onRelayTokenInvalid）：清掉 .env 里的令牌、刷目录与能力表。
 * 页面下一次查 /api/auth/status 看到 loggedIn:false + expired:true，回登录页并说明原因。
 * @returns {Promise<boolean>} 真的清了没有（令牌已经换过就不动）
 */
export async function handleRelayTokenInvalid(deadToken) {
  if (!deadToken || (process.env.NODESIGN_RELAY_TOKEN || '').trim() !== deadToken) return false;
  setEnvValues({ NODESIGN_RELAY_TOKEN: null });
  console.warn('[relay] 本机设备令牌已清除，需要重新登录站点账号');
  await refreshRelayCatalog();
  await probeCapabilities({ force: true });
  return true;
}

function pageHtml(req, { ok, title, body }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mark = ok ? '✓' : '!';
  return `<!doctype html><html lang="${String(req.headers['accept-language'] || '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · NoDesign</title></head>`
    + `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f1ea;color:#1f1d1a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',Arial,sans-serif">`
    + `<main style="max-width:420px;margin:24px;padding:32px;background:#fffdf8;border:1.5px solid #1f1d1a;box-shadow:4px 4px 0 #1f1d1a">`
    + `<p style="margin:0 0 16px;font-weight:600;letter-spacing:1px">NoDesign</p>`
    + `<h1 style="margin:0 0 12px;font-size:20px">${mark} ${esc(title)}</h1>`
    + `<p style="margin:0;line-height:1.7;color:#4a463f">${esc(body)}</p></main></body></html>`;
}

function sendPage(req, res, status, content) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  }).send(pageHtml(req, content));
}

const router = express.Router();

router.post('/browser-login', (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'expected application/json', code: 'BAD_CONTENT_TYPE' });
  sweep();
  const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const url = normalizeRelayUrl(rawUrl || process.env.NODESIGN_RELAY_URL);
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return res.status(400).json({ error: msg(req, '站点地址无效'), code: 'BAD_URL' });
  const port = req.socket.localPort;
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const waiting = [...pendings.entries()].filter(([, p]) => p.status === 'pending' && !p.busy);
  if (waiting.length >= MAX_PENDING) pendings.delete(waiting[0][0]);   // 正在换令牌的那条不删
  pendings.set(state, { verifier, url, urlExplicit: !!rawUrl, createdAt: Date.now(), status: 'pending', error: null, busy: false, finishedAt: 0 });
  const q = new URLSearchParams({ port: String(port), state, challenge, device: os.hostname().slice(0, 60) });
  res.status(201).json({ state, authorizeUrl: `${url}/desktop-auth?${q}` });
});

router.get('/browser-login/:state', (req, res) => {
  sweep();
  const p = pendings.get(req.params.state);
  if (!p) return res.json({ status: 'expired', error: null });
  res.json({ status: p.status, error: p.error });
});

router.delete('/browser-login/:state', (req, res) => {
  const p = pendings.get(req.params.state);
  if (p?.busy) return res.json({ ok: false, busy: true, status: p.status });
  if (p && p.status === 'pending') { p.status = 'cancelled'; p.finishedAt = Date.now(); }
  res.json({ ok: p?.status === 'cancelled', busy: false, status: p?.status || 'expired' });
});

router.get('/callback', async (req, res) => {
  sweep();
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const p = state ? pendings.get(state) : null;
  if (!p || p.status !== 'pending') {
    return sendPage(req, res, 400, { ok: false, title: msg(req, '登录请求无效或已过期'), body: msg(req, '请回到 NoDesign，重新点击「在浏览器中登录」。') });
  }
  if (req.query.error) {
    if (p.busy) return sendPage(req, res, 409, { ok: false, title: msg(req, '正在完成登录'), body: msg(req, '请回到 NoDesign 查看结果。') });
    p.status = 'cancelled'; p.finishedAt = Date.now();
    return sendPage(req, res, 200, { ok: false, title: msg(req, '已取消登录'), body: msg(req, '可以关闭此页面。') });
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) return sendPage(req, res, 400, { ok: false, title: msg(req, '登录请求无效或已过期'), body: msg(req, '请回到 NoDesign，重新点击「在浏览器中登录」。') });
  if (p.busy) return sendPage(req, res, 409, { ok: false, title: msg(req, '正在完成登录'), body: msg(req, '请回到 NoDesign 查看结果。') });
  p.busy = true;
  try {
    const r = await relayExchangeCode({ url: p.url, code, verifier: p.verifier });
    if (relayConfig()) await relayLogout();   // 本机原来还有一枚令牌（另一条等待先成功过）：换号前吊销旧的，失败只记日志
    await applyRelayToken({ token: r.token, url: p.urlExplicit ? p.url : null });
    const now = Date.now();
    for (const other of pendings.values()) if (other !== p && other.status === 'pending') { other.status = 'superseded'; other.finishedAt = now; }
    p.status = 'done'; p.error = null; p.finishedAt = now;
    return sendPage(req, res, 200, { ok: true, title: msg(req, '已登录 NoDesign'), body: msg(req, '可以关闭此页面，回到 NoDesign 继续使用。') });
  } catch (err) {
    p.error = err.message;
    // 设备数满、被限频：再等也不会自己好，直接结束让页面显示原因。码无效：可能是外站塞的假码，真的那次还可能在后面到，接着等
    if (err.code === 'TOO_MANY_DEVICES' || err.code === 'RATE_LIMITED') { p.status = 'failed'; p.finishedAt = Date.now(); }
    return sendPage(req, res, err.status === 409 ? 409 : 400, { ok: false, title: msg(req, '登录没有完成'), body: err.message });
  } finally {
    p.busy = false;
  }
});

/** 测试用 */
export function _resetBrowserLogins() { pendings.clear(); }

export default router;
