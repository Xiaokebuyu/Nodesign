/**
 * server/hosted/relay/subscription-leg.js —— relay 的订阅腿：拿站主的 OAuth 凭据把请求转给 Anthropic。
 *
 * ## 为什么这条腿在 hosted 而不在 lib/ingress
 *
 * 站内的订阅会话不经入口：SDK binary 自己读 ~/.claude 的凭据直连 Anthropic（session-loop
 * 那段"订阅模型什么都不注入"）。桌面版没有站主的凭据，它的 SDK 把请求发到 relay，
 * relay 在这里换上站主的 token 再转出去。凭据只在服务器上，永远不发给客户端。
 *
 * ## 谁能走
 *
 * gates.js 闸 1（档位含 subscription）已经在门口判过。这里只管转发，不复判 —— 判决只在一处。
 *
 * ## 凭据
 *
 * <claudeConfigDir>/.credentials.json 的 claudeAiOauth.accessToken（Linux/Windows 的落盘处，
 * platform.claudeAuthPresent 认的就是这个文件）。按 mtime 缓存，CLI 刷新 token 时会重写文件，
 * 下一发自然读到新的。⚠️ 刷新是 CLI 做的事：站内长时间没有订阅会话的话 token 会过期，
 * 这条腿只会看到上游 401 —— 日志里给出提示，让站主跑一次 `claude login`。自己刷新
 * 是下一步的事（refreshToken 在同一个文件里），先别在这儿做半个。
 *
 * ## 头
 *
 * - authorization / x-api-key：丢掉客户端的（那是设备令牌），换成 Bearer <站主 token>
 * - anthropic-beta：OAuth 请求必须带 oauth-2025-04-20；SDK 在 ANTHROPIC_AUTH_TOKEN 模式下
 *   发不发不确定，缺了就补上，有就原样
 * - 其余原样透传（anthropic-version、user-agent、x-app 之类都是 SDK 自己的事）
 *
 * ## 账
 *
 * 用 lib/ingress/anthropic-usage 旁听 token 数。订阅行没有 prices（站主按月付，不按 token），
 * 所以 costUsd 报 null，账本记 0 并告警 —— 这是**已知缺口**：pro 档走 relay 的订阅用量不计入
 * 日额度。站内对应的口径是 SDK 自报的 Claude 表价；要对齐得给订阅行填 prices。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { platform } from '../../runtime/platform.js';
import { tapAnthropicUsage } from '../../lib/ingress/anthropic-usage.js';
import { armIdleWatchdog } from '../../lib/ingress/stream-watchdog.js';

const ANTHROPIC_HOST = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
const PREFIX_RE = /^\/__nd\/([^/]+)(\/.*)$/;

let cache = { mtimeMs: -1, token: null, expiresAt: null };
let lastExpiredWarn = 0;

/** 读站主 token（按 mtime 缓存）。没有 → null */
export function ownerOauthToken(credPath = path.join(platform.claudeConfigDir, '.credentials.json')) {
  let st;
  try { st = fs.statSync(credPath); } catch { return null; }
  if (st.mtimeMs !== cache.mtimeMs) {
    try {
      const j = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const o = j?.claudeAiOauth || {};
      cache = { mtimeMs: st.mtimeMs, token: typeof o.accessToken === 'string' && o.accessToken ? o.accessToken : null, expiresAt: Number(o.expiresAt) || null };
    } catch {
      cache = { mtimeMs: st.mtimeMs, token: null, expiresAt: null };
    }
  }
  if (cache.token && cache.expiresAt && cache.expiresAt < Date.now() && Date.now() - lastExpiredWarn > 60_000) {
    lastExpiredWarn = Date.now();
    console.warn('[relay/subscription] 站主 OAuth token 按 expiresAt 已过期，仍会尝试转发；持续 401 的话站主跑一次 `claude login`');
  }
  return cache.token;
}

/** 测试用 */
export function _resetOwnerTokenCache() { cache = { mtimeMs: -1, token: null, expiresAt: null }; }

/**
 * 转发一发订阅请求。
 *
 * @param {object} req       express req（只读 method / url / headers）
 * @param {object} res
 * @param {Buffer} bodyBuf   原始 body（原样转，不修补 —— 订阅行是真 Claude，不需要入口那套修补）
 * @param {object} opts
 * @param {(tokens: object) => void} [opts.onUsage]
 * @param {string} [opts.token]     测试注入；默认读凭据文件
 * @param {{ host?: string, port?: number, useHttps?: boolean }} [opts.target]  测试注入：指向假上游
 */
export function forwardSubscription(req, res, bodyBuf, { onUsage = null, token = undefined, target = null } = {}) {
  const m = PREFIX_RE.exec(req.url);
  const origPath = m ? m[2] : req.url;
  const sidShort = m ? decodeURIComponent(m[1]).slice(0, 8) : '-';

  if (!(req.method === 'POST' && /^\/v1\/messages\b/.test(origPath))) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`relay/subscription: unsupported ${req.method} ${origPath}`);
    return;
  }
  const bearer = token === undefined ? ownerOauthToken() : token;
  if (!bearer) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('relay/subscription: 服务器上没有站主的 Claude 凭据（<claudeConfigDir>/.credentials.json）');
    console.warn(`[relay/subscription] sid=${sidShort} 没有凭据可转，502`);
    return;
  }

  const host = target?.host || ANTHROPIC_HOST;
  const useHttps = target ? target.useHttps !== false : true;
  const headers = { ...req.headers, host };
  delete headers['x-api-key'];
  delete headers['authorization'];
  delete headers['Authorization'];
  delete headers['content-length'];
  delete headers['connection'];
  headers['authorization'] = `Bearer ${bearer}`;
  const betas = String(headers['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.unshift(OAUTH_BETA);
  headers['anthropic-beta'] = betas.join(',');
  headers['content-length'] = String(bodyBuf.length);

  const isCountTokens = /^\/v1\/messages\/count_tokens\b/.test(origPath);
  // 真上游永远 https；http 只给测试的假上游用
  const proxyReq = (useHttps ? https : http).request({
    hostname: host,
    port: target?.port || (useHttps ? 443 : 80),
    path: origPath,
    method: 'POST',
    headers,
  }, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const preview = Buffer.concat(chunks).slice(0, 200).toString('utf8').replace(/\s+/g, ' ');
        const hint = proxyRes.statusCode === 401 ? '（站主凭据失效？跑一次 `claude login`）' : '';
        console.warn(`[relay/subscription] sid=${sidShort} ${proxyRes.statusCode}${hint} body=${preview}`);
      });
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    if (proxyRes.statusCode < 400 && String(proxyRes.headers['content-type'] || '').includes('event-stream')) {
      armIdleWatchdog(proxyRes, { onIdle: (silentMs) => {
        console.warn(`[relay/subscription] sid=${sidShort} 流静默 ${Math.round(silentMs / 1000)}s —— 看门狗掐断死流`);
        try { proxyRes.destroy(new Error('relay stream idle watchdog')); } catch { /* 已经死了 */ }
      } });
    }
    if (onUsage && !isCountTokens) tapAnthropicUsage(proxyRes, { onUsage });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    const detail = err.code ? `${err.code}: ${err.message}` : err.message;
    console.error(`[relay/subscription] sid=${sidShort} forward error: ${detail}`);
    try { res.writeHead(502); res.end(`relay forward error: ${detail}`); } catch { /* ignore */ }
  });
  proxyReq.write(bodyBuf);
  proxyReq.end();
}
