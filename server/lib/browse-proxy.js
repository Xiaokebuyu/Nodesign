/**
 * server/lib/browse-proxy.js — 浏览通道的出网闸，装在**代理层**（2026-08-18）
 *
 * ## 为什么闸从 CDP 挪到代理
 *
 * 第一版把闸装在 CDP 的 `Fetch.requestPaused` 上。它拦得住导航、子资源、跳转每一跳、
 * 跨源 iframe —— 但审查真攻出来四条它**根本看不见**的路：
 *
 *   - **WebSocket 握手**（`ws://127.0.0.1:4001` 双向读到了数据）
 *   - **`<link rel=prefetch>` / speculation rules**（打到了生产 :4001）
 *   - **`navigator.sendBeacon`**
 *   - **还没装上闸的弹窗**（`window.open` / `target=_blank`，在那 250ms 窗口里
 *     能发 GET 和 POST，还能循环开）
 *
 * 共同点是它们都不走 `Fetch` 那个阶段。**逐条补是补不完的** —— 下一个 web 平台特性
 * 又会开一条。所以闸挪到**所有出网都必经的那一层**：给这个浏览器挂一个我们自己的
 * HTTP 代理，`--proxy-server` 之后 chromium 的每一次连接都从这儿走。
 * 实测代理确实看得到上面四条全部（包括 WS 的 `CONNECT 127.0.0.1:4001`）。
 *
 * ## 附带白拿的两件
 *
 * 1. ⭐ **DNS 重绑定被根除，不再是"缓解"。** 我们自己解析、自己**连那个验过的 IP**
 *    （pin），浏览器拿不到第二次解析的机会。CDP 那版只能是"解析一次→浏览器再解析
 *    一次"，中间有 TOCTOU 窗口，而且主机名缓存把窗口变成了保证 30 秒的洞。
 * 2. **没有初始化竞态。** 代理在浏览器启动参数里，第一个字节之前就生效；
 *    CDP 那版要等 `Fetch.enable` 握手完，弹窗根本等不到。
 *
 * CDP 那道闸**保留**当纵深（它能给出漂亮的按请求记账），但不再是唯一一道。
 *
 * ## 感知通道不挂代理
 *
 * 感知通道（看自己产物）**故意**走 loopback 的 artifact-file，它必须能到 127.0.0.1。
 * 所以只有浏览通道的浏览器带 `--proxy-server`，两条通道在这一层物理分开。
 */

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { blockReason } from './ssrf-guard.js';
import { isRegisteredLoopback } from '../engine/process/registry.js';

/** 允许连的端口。80/443 之外的公网端口极少是设计参考站，而放开等于多一片攻击面。 */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const RESOLVE_TIMEOUT_MS = 4000;
const CONNECT_TIMEOUT_MS = 15_000;

let server = null;
let port = 0;
const blocked = [];

function note(target, reason) {
  blocked.push({ target, reason, at: Date.now() });
  if (blocked.length > 200) blocked.shift();
}

/**
 * 解析 + 判定，返回可以连的那个 IP（**pin 住它**，不把主机名交给下游再解析一次）。
 * @returns {Promise<{ip: string, family: number} | {deny: string}>}
 */
async function resolveAllowed(host, portNum) {
  // 进程卡（2026-09-07）：agent 自己起的 dev server 在本机，登记表里在跑的端口放行，pin 到 127.0.0.1
  if (isRegisteredLoopback(host, portNum)) return { ip: '127.0.0.1', family: 4 };
  if (!ALLOWED_PORTS.has(portNum)) {
    return { deny: `port ${portNum} is not allowed (only ${[...ALLOWED_PORTS].join('/')})` };
  }
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) {
    return { deny: `${bare} resolves inside the local network` };
  }
  // 字面量 IP 不劳烦 DNS
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.includes(':')) {
    const why = blockReason(bare);
    return why ? { deny: why } : { ip: bare, family: bare.includes(':') ? 6 : 4 };
  }
  let addrs;
  try {
    addrs = await Promise.race([
      dns.lookup(bare, { all: true, verbatim: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), RESOLVE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    // ⚠️ kind:'dns' 是给 denyBody 分文案用的：解析失败**不是策略拦截**。
    // 第一版对 NXDOMAIN 也甩「内网与本机地址是硬边界」，agent 上报时据此
    // 推理出一整套"代理有两个解析器"的错误理论 —— 错误提示比没提示更贵。
    return { deny: `cannot resolve ${bare}: ${err.message}`, kind: 'dns' };
  }
  if (!addrs.length) return { deny: `${bare} resolved to nothing`, kind: 'dns' };
  // **任一**地址落在禁止段就整个拒 —— 多 A 记录里混一条内网是标准起手式，
  // "挑一个能用的"等于自己开门
  for (const a of addrs) {
    const why = blockReason(a.address);
    if (why) return { deny: `${bare} → ${why}` };
  }
  return { ip: addrs[0].address, family: addrs[0].family };
}

// 按拒因分文案：DNS 解析失败要说清"这个域名现在指不到任何地方"，
// 策略拦截才配那句硬边界 —— 两种拒混着说，agent 会朝错误的方向排障。
const denyTail = (kind) => (kind === 'dns'
  ? '这是域名解析失败（域名可能不存在、拼错或已下线），不是出网策略拦截。'
  : '内网与本机地址是硬边界，不是可配置项。');

const denyBody = (reason, kind) => {
  const body = `拒绝出网：${reason}\n\n${denyTail(kind)}`;
  return `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
};

/** 启动（幂等）。@returns {Promise<{port:number, blocked:Array}>} */
export async function startBrowseProxy() {
  if (server) return { port, blocked };

  server = http.createServer();

  // 明文 http：绝对形式的请求行（`GET http://host/path`）
  server.on('request', async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch {
      res.writeHead(400); return res.end('proxy: bad absolute-form request');
    }
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const verdict = await resolveAllowed(u.hostname, p);
    if (verdict.deny) {
      note(`${u.hostname}:${p}`, verdict.deny);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`拒绝出网：${verdict.deny}\n\n${denyTail(verdict.kind)}`);
    }
    // 连**验过的那个 IP**，Host 头保留原主机名（虚拟主机才认得出）
    const upstream = http.request({
      host: verdict.ip, port: p, method: req.method,
      path: u.pathname + u.search,
      headers: { ...req.headers, host: u.host },
      timeout: CONNECT_TIMEOUT_MS,
      setHost: false,
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`proxy upstream error: ${err.message}`);
    });
    req.pipe(upstream);
  });

  // CONNECT：https / wss 都走这条（**WS 就是靠它被盖住的**）
  server.on('connect', async (req, socket, head) => {
    const [rawHost, rawPort] = String(req.url || '').split(':');
    const p = Number(rawPort || 443);
    const verdict = await resolveAllowed(rawHost || '', p);
    if (verdict.deny) {
      note(`${rawHost}:${p}`, verdict.deny);
      socket.write(denyBody(verdict.deny, verdict.kind));
      return socket.destroy();
    }
    const up = net.connect({ host: verdict.ip, port: p }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: nodesign-browse\r\n\r\n');
      if (head?.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.setTimeout(CONNECT_TIMEOUT_MS, () => up.destroy());
    up.on('error', () => { try { socket.destroy(); } catch { /* */ } });
    socket.on('error', () => { try { up.destroy(); } catch { /* */ } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  server.unref?.();
  console.log(`[browse-proxy] listening on 127.0.0.1:${port}`);
  return { port, blocked };
}

/** 给工具的返回值用：这次调用期间拦了什么 */
export function blockedSince(n) {
  return blocked.slice(n);
}
export function blockedCount() {
  return blocked.length;
}
export const _proxy = { ALLOWED_PORTS };
