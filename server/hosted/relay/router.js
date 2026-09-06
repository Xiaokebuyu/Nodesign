/**
 * server/hosted/relay/router.js —— relay 的 HTTP 层。挂在 /api/relay，**在 express.json 之前**
 * （它要原始 body：转发要逐字节转，全局 JSON 解析器会把流吃掉）。
 *
 * ## 一发推理请求的路
 *
 *   设备令牌 → 用户            devices.js（Bearer ndk_…）
 *   sid → 会话登记             sessions.js（客户端起 query 前 POST /sessions 登记过）
 *   判决                        gates.js（档位 / 额度 / 外审，按登记的 appModel）
 *   转发                        订阅腿 subscription-leg.js ｜ API 腿 lib/model-ingress.handleRequest
 *   记账                        usage.js（每一发上游响应记一笔；上游自报的钱优先，否则按表价）
 *
 * 判决和记账都在这台机器上；客户端只负责把 SDK 的 base URL 指过来。
 *
 * ## 端点
 *
 *   POST   /login                  { username, password, label } → 账号密码换一枚设备令牌（桌面版登录；不需要令牌）
 *   POST   /logout                 吊销当前这枚令牌（桌面版退出登录）
 *   GET    /whoami                 令牌对应的用户、档位、额度快照（客户端设置页用）
 *   GET    /models                 这个账号在这台服务器上能选的行（两个面的并集；客户端选择器按它过滤）
 *   POST   /sessions               { sid, appModel } → 201；档位不够当场 403（省得起了 SDK 才知道）
 *   DELETE /sessions/:sid
 *   POST   /__nd/:sid/v1/messages  推理（SDK 的 ANTHROPIC_BASE_URL = <site>/api/relay/__nd/<sid>）
 *   POST   /__nd/:sid/v1/messages/count_tokens
 *   POST   /tools/web_search       网关替桌面版搜（站主的 key；basic 档日上限）        tools.js
 *   POST   /tools/generate_image   网关替桌面版出图（站主的通道；$0.20/张进账本）      tools.js
 *
 * 拒绝一律回 Anthropic 错误形状 {type:'error', error:{type, message}} 外加我们自己的 code：
 * SDK 认得前者能把话显示给用户，客户端认得后者能做对应的引导（换模型 / 明天再来）。
 */

import express from 'express';
import { verifyDeviceToken, tokenFromRequest, mintDevice, revokeDevice, listDevices, MAX_DEVICES } from './devices.js';
import { checkPassword } from '../auth-routes.js';
import { getUserById } from '../../auth/users-store.js';
import { openRelaySession, closeRelaySession, lookupRelaySession, startRelaySessionSweeper } from './sessions.js';
import { decideRelay } from './gates.js';
import { recordRelayUsage, installRelayUsageSource, relayDailySeries } from './usage.js';
import { forwardSubscription } from './subscription-leg.js';
import { handleRequest as forwardViaIngress } from '../../lib/model-ingress.js';
import { priceTokens, resolveModelRoute, hasSubscriptionAccess, selectableModelsFor, PICKER_SCOPES } from '../../engine/agent/model-context.js';
import { checkQuota } from '../../lib/quota.js';
import { tierOf } from '../../auth/tier.js';
import { mountRelayTools, relayToolsFor } from './tools.js';

const BODY_MAX = 64 * 1024 * 1024;   // 带图的 Messages body 能到十几 MB；站内入口本来没有上限

function sendError(res, status, code, message, extra = {}) {
  const type = status === 401 ? 'authentication_error' : status === 403 || status === 402 ? 'permission_error' : status === 429 ? 'rate_limit_error' : 'invalid_request_error';
  const body = JSON.stringify({ type: 'error', error: { type, message }, code, ...extra });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/** 读原始 body（有上限）。超限 → reject */
function readRawBody(req, max = BODY_MAX) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function deviceAuth(req, res, next) {
  const token = tokenFromRequest(req);
  const hit = token ? verifyDeviceToken(token) : null;
  if (!hit) return sendError(res, 401, 'DEVICE_TOKEN_INVALID', '设备令牌无效或已吊销。');
  req.relayUser = hit.user;
  req.relayDevice = hit.device;
  next();
}

export function createRelayRouter({ forwardApi = forwardViaIngress, forwardSub = forwardSubscription, moderate = undefined, tools = {} } = {}) {
  const router = express.Router();

  // 桌面版登录：账号密码 → 设备令牌。跟网页登录同一套核验和爆破锁（hosted/auth-routes.checkPassword）。
  // 在 deviceAuth 之前：这是唯一一条不带令牌就能走的路。
  router.post('/login', async (req, res) => {
    let body;
    try { body = JSON.parse((await readRawBody(req, 64 * 1024)).toString('utf8') || '{}'); }
    catch { return sendError(res, 400, 'BAD_JSON', '请求体不是 JSON'); }
    const { username, password } = body || {};
    const r = checkPassword(req, username, password);
    if (!r.ok) return sendError(res, r.status, r.status === 429 ? 'RATE_LIMITED' : 'BAD_CREDENTIALS', r.message);
    const user = getUserById(r.userId);
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    const active = listDevices(user.id).filter((d) => !d.revoked);
    if (active.length >= MAX_DEVICES) return sendError(res, 409, 'TOO_MANY_DEVICES', `最多 ${MAX_DEVICES} 台在用的设备，到站点「桌面版设备」吊销一台`);
    const { device, token } = mintDevice({ userId: user.id, label: label || null });
    res.status(201).json({ token, device: { id: device.id, label: device.label }, user: { id: user.id, username: user.username, tier: tierOf(user) } });
  });

  router.use(deviceAuth);

  // 用量曲线（桌面版设置页「用量」）：这个账号在站点账本里近 N 天每日每模型的花费
  router.get('/usage/daily', (req, res) => {
    const days = Number(req.query.days) || 30;
    res.json({ days, series: relayDailySeries(req.relayUser.id, days) });
  });

  router.post('/logout', (req, res) => {
    revokeDevice(req.relayDevice.id);
    res.json({ ok: true });
  });

  router.get('/whoami', (req, res) => {
    const user = req.relayUser;
    const quota = checkQuota(user);
    res.json({
      user: { id: user.id, username: user.username, tier: tierOf(user) },
      device: { id: req.relayDevice.id, label: req.relayDevice.label },
      capabilities: { subscription: hasSubscriptionAccess(user) },
      // 网关替这个账号跑的工具（桌面版没有钥匙的那几件）：客户端的能力位和工具选路都按这张表
      tools: relayToolsFor(user),
      quota: { kind: quota.kind, used: quota.used, limit: quota.limit },
    });
  });

  // 工具中继（搜索 / 生图）：tools.js
  mountRelayTools(router, { sendError, readRawBody, ...tools });

  // 目录：客户端拿着同一张 model-table，只需要知道"哪些行这个账号能用、哪些锁着"。两个选择器面（canvas / stage）
  // 的并集，面的过滤客户端自己做。字段只给 id / locked / lockReason，标签和描述客户端表里有。
  router.get('/models', (req, res) => {
    const byId = new Map();
    for (const scope of PICKER_SCOPES) {
      for (const m of selectableModelsFor(req.relayUser, { scope })) {
        if (!byId.has(m.id)) byId.set(m.id, { id: m.id, locked: !!m.locked, ...(m.lockReason ? { lockReason: m.lockReason } : {}) });
      }
    }
    res.json({ models: [...byId.values()] });
  });

  router.post('/sessions', async (req, res) => {
    let body;
    try { body = JSON.parse((await readRawBody(req, 64 * 1024)).toString('utf8') || '{}'); }
    catch { return sendError(res, 400, 'BAD_JSON', '请求体不是 JSON'); }
    const { sid, appModel } = body || {};
    const user = req.relayUser;
    // 档位闸提前到登记：客户端选了订阅模型而档位不够，这里就说，别等 SDK 起来第一发才 403
    if (resolveModelRoute(appModel).mode === 'subscription' && !hasSubscriptionAccess(user)) {
      return sendError(res, 403, 'SUBSCRIPTION_REQUIRED', '这个账号没有订阅通路资格，换一个 API 模型。');
    }
    const r = openRelaySession({ sid, appModel, userId: user.id, deviceId: req.relayDevice.id });
    if (!r.ok) return sendError(res, r.status, r.code, r.message);
    res.status(201).json({ sid: r.session.sid, appModel: r.session.appModel, mode: r.session.mode });
  });

  router.delete('/sessions/:sid', (req, res) => {
    closeRelaySession(req.params.sid, req.relayUser.id);
    res.status(204).end();
  });

  router.post(/^\/__nd\/([^/]+)\/v1\/messages(\/count_tokens)?$/, async (req, res) => {
    const user = req.relayUser;
    const device = req.relayDevice;
    const sid = decodeURIComponent(req.params[0]);
    const { session, reason } = lookupRelaySession(sid, user.id);
    if (!session) {
      return reason === 'foreign'
        ? sendError(res, 403, 'SID_FOREIGN', '这个会话不是你登记的。')
        : sendError(res, 400, 'SESSION_UNKNOWN', '会话没登记：起 query 之前先 POST /api/relay/sessions。');
    }

    let bodyBuf;
    try { bodyBuf = await readRawBody(req); }
    catch (err) { return sendError(res, err.status || 400, 'BAD_BODY', err.message); }
    let parsed;
    try { parsed = JSON.parse(bodyBuf.toString('utf8')); }
    catch { return sendError(res, 400, 'BAD_JSON', '请求体不是 JSON'); }

    const isCountTokens = !!req.params[1];
    // count_tokens 不是推理：不花钱、不带新内容，只过身份和会话，别为它打一次外审
    const verdict = isCountTokens
      ? { ok: true }
      : await decideRelay({ user, body: parsed, appModel: session.appModel }, moderate ? { moderate } : undefined);
    if (!verdict.ok) return sendError(res, verdict.status, verdict.code, verdict.message, verdict.quota ? { quota: verdict.quota } : {});

    const book = ({ appModel, costUsd, tokens }) => {
      // 上游自报的钱 **>0 才算数**（Zen Go 额度内报 0、余额不扣 —— 站内 context.applyUpstreamBilling 同一口径：
      // 09-07 站主桌面版 21 发 DeepSeek 账本全是 0 就是把 0 当真数记了）；否则按表价；都没有 → usage.js 记 0 并告警
      const cost = costUsd != null && costUsd > 0 ? costUsd : (tokens ? priceTokens(appModel, tokens) : null);
      try {
        recordRelayUsage({ userId: user.id, deviceId: device.id, model: appModel, costUsd: cost,
          inputTokens: tokens?.input ?? null, outputTokens: tokens?.output ?? null,
          cacheRead: tokens?.cacheRead ?? null, cacheCreate: tokens?.cacheCreate ?? null });
      } catch (err) {
        console.error(`[relay] 记账失败 user=${user.id} model=${appModel}: ${err?.message || err}`);
      }
    };

    if (session.mode === 'subscription') {
      // 订阅行没有 prices：costUsd 走 null → 记 0（subscription-leg.js 头上写明了这是已知缺口）
      forwardSub(req, res, bodyBuf, { onUsage: (tokens) => book({ appModel: session.appModel, costUsd: null, tokens }) });
      return;
    }
    try {
      await forwardApi(req, res, bodyBuf, { onBilling: book });
    } catch (err) {
      console.error(`[relay] forward error: ${err?.stack || err?.message || err}`);
      if (!res.headersSent) sendError(res, 502, 'FORWARD_FAILED', err?.message || 'forward failed');
      else { try { res.end(); } catch { /* ignore */ } }
    }
  });

  // 别漏到后面的登录墙去（那边按 cookie 判，回的 401 会把客户端带沟里）
  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', `relay: ${req.method} ${req.originalUrl}`));
  return router;
}

/** 生产用：装上账本来源 + 起清扫器，然后给一个路由器 */
export function mountRelay(app, mountPath = '/api/relay') {
  installRelayUsageSource();
  startRelaySessionSweeper();
  app.use(mountPath, createRelayRouter());
  console.log(`[relay] mounted at ${mountPath}`);
}
