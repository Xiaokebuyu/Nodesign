/**
 * mcp-server/probes.js —— 诊断端点的主动探针（2026-09-08 站主定「多埋几个点」）：
 *   networkProbe：解析站点域名（198.18.x = Clash/Surge fake-ip，说明代理在中间）、TCP+TLS 握手耗时、
 *                 到 /api/health 的往返、系统代理环境变量。首发「API 重试中 — unknown」这种连接层的事先看它。
 *   relayProbe  ：拿当前设备令牌真打 /whoami、/models、/notice，报状态码与耗时；分清「登录态坏了」和「模型不可用」。
 * 都是只读、都有超时；失败落进返回值不抛。
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { relayConfig, normalizeRelayUrl, DEFAULT_RELAY_URL } from '../runtime/relay-client.js';

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const isFakeIp = (ip) => /^198\.1[89]\./.test(ip);

function timed(fn, ms) {
  return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms).unref?.())]);
}
async function tcpConnect(host, port, ms) {
  const t0 = Date.now();
  await timed(() => new Promise((res, rej) => { const s = net.connect({ host, port }); s.once('connect', () => { s.destroy(); res(); }); s.once('error', rej); }), ms);
  return Date.now() - t0;
}
async function tlsConnect(host, port, ms) {
  const t0 = Date.now();
  const info = await timed(() => new Promise((res, rej) => {
    const s = tls.connect({ host, port, servername: host }, () => { const c = s.getPeerCertificate(); const out = { protocol: s.getProtocol(), alpn: s.alpnProtocol || null, issuer: c?.issuer?.O || null, validTo: c?.valid_to || null }; s.destroy(); res(out); });
    s.once('error', rej);
  }), ms);
  return { ms: Date.now() - t0, ...info };
}

export async function networkProbe({ url = null, timeoutMs = 8000, fetchImpl = fetch, resolver = dns } = {}) {
  const base = normalizeRelayUrl(url || relayConfig()?.url || process.env.NODESIGN_RELAY_URL || DEFAULT_RELAY_URL);
  const u = new URL(base);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const out = { target: base, host: u.hostname, port, proxyEnv: Object.fromEntries(PROXY_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), dns: null, tcp: null, tls: null, http: null, verdict: [] };
  try {
    const t0 = Date.now();
    const addrs = await timed(() => resolver.lookup(u.hostname, { all: true }), timeoutMs);
    out.dns = { ms: Date.now() - t0, addresses: addrs.map((a) => a.address) };
    if (addrs.some((a) => isFakeIp(a.address))) out.verdict.push('DNS 解析到 198.18.x：本机开着 fake-ip 模式的代理（Clash / Surge 一类），连接都经它转发');
  } catch (err) { out.dns = { error: err.message }; out.verdict.push(`DNS 解析失败：${err.message}`); }
  try { out.tcp = { ms: await tcpConnect(u.hostname, port, timeoutMs) }; } catch (err) { out.tcp = { error: err.message }; out.verdict.push(`TCP 连不上 ${u.hostname}:${port}：${err.message}`); }
  if (u.protocol === 'https:' && !out.tcp?.error) {
    try { out.tls = await tlsConnect(u.hostname, port, timeoutMs); } catch (err) { out.tls = { error: err.message }; out.verdict.push(`TLS 握手失败：${err.message}`); }
  }
  try {
    const t0 = Date.now();
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/api/health`, { signal: ctrl.signal });
      out.http = { ms: Date.now() - t0, status: r.status, server: r.headers.get('server') || null, cfRay: r.headers.get('cf-ray') || null };
      if (r.status !== 200) out.verdict.push(`/api/health 回 ${r.status}`);
    } finally { clearTimeout(timer); }
  } catch (err) { out.http = { error: err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message }; out.verdict.push(`HTTP 往返失败：${out.http.error}`); }
  if (!out.verdict.length) out.verdict.push('链路正常');
  return out;
}

export async function relayProbe({ fetchImpl = fetch, timeoutMs = 8000, cfg = relayConfig() } = {}) {
  if (!cfg) return { configured: false, verdict: ['没有 relay 令牌（没登录站点）'] };
  const out = { configured: true, url: cfg.url, calls: {}, verdict: [] };
  for (const p of ['/whoami', '/models', '/notice']) {
    const t0 = Date.now();
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${cfg.url}/api/relay${p}`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: ctrl.signal });
      let body = null; try { body = await r.json(); } catch { /* 非 JSON */ }
      const call = { ms: Date.now() - t0, status: r.status };
      if (p === '/whoami' && body) { call.user = body.user?.username ?? null; call.tier = body.user?.tier ?? null; call.capabilities = body.capabilities ?? null; }
      if (p === '/models' && body) call.models = (Array.isArray(body.models) ? body.models : []).map((m) => ({ id: m.id, locked: !!m.locked, reason: m.lockReason || null }));
      out.calls[p] = call;
      if (r.status === 401) out.verdict.push('令牌被拒（401）：重新登录站点');
      else if (r.status >= 400) out.verdict.push(`${p} 回 ${r.status}`);
    } catch (err) { out.calls[p] = { ms: Date.now() - t0, error: err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message }; out.verdict.push(`${p} 失败：${out.calls[p].error}`); }
    finally { clearTimeout(timer); }
  }
  if (!out.verdict.length) out.verdict.push('relay 正常');
  return out;
}
