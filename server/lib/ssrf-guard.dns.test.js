/**
 * 出网闸的 DNS 失败分档与记账（09-17）。
 * - 超时不能说成「域名可能不存在」（agent 会据此放弃一个只是慢了一拍的站）
 * - CDP 那道闸的记账带上 kind / dns：导航被拒时 playwright 只给 ERR_ACCESS_DENIED，
 *   调用方靠这里分辨解析失败与策略拦截（问题库 iss_mu039zaz_vydt）
 * DNS 换成假的：不联网。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';

const lookup = vi.fn();
vi.mock('node:dns/promises', () => ({ default: { lookup: (...a) => lookup(...a) } }));

const { dnsFailKind, dnsFailText, checkUrl, attachSsrfGuard } = await import('./ssrf-guard.js');
const { startBrowseProxy } = await import('./browse-proxy.js');

const codeErr = (code, msg = `getaddrinfo ${code} x`) => Object.assign(new Error(msg), { code });

beforeEach(() => lookup.mockReset());

describe('dnsFailKind / dnsFailText', () => {
  it('EAI_AGAIN 与自己的竞速超时 → timeout；ENOTFOUND / ENODATA → nxdomain；其它 → other', () => {
    expect(dnsFailKind(codeErr('EAI_AGAIN'))).toBe('timeout');
    expect(dnsFailKind(new Error('dns timeout'))).toBe('timeout');
    expect(dnsFailKind(codeErr('ENOTFOUND'))).toBe('nxdomain');
    expect(dnsFailKind(codeErr('ENODATA'))).toBe('nxdomain');
    expect(dnsFailKind(codeErr('ECONNREFUSED'))).toBe('other');
  });
  it('超时的那句说重试、不说不存在；只有 nxdomain 才说可能不存在', () => {
    expect(dnsFailText('timeout')).toMatch(/超时.*重试一次/);
    expect(dnsFailText('timeout')).not.toContain('不存在');
    expect(dnsFailText('nxdomain')).toContain('可能不存在');
    expect(dnsFailText('other')).not.toContain('不存在');
    for (const k of ['timeout', 'nxdomain', 'other']) expect(dnsFailText(k)).toContain('不是出网策略拦截');
  });
});

describe('checkUrl 带出 dns 分档', () => {
  it('EAI_AGAIN → kind dns / dns timeout', async () => {
    lookup.mockRejectedValueOnce(codeErr('EAI_AGAIN'));
    expect(await checkUrl('https://slow-0917.example.com/')).toMatchObject({ ok: false, kind: 'dns', dns: 'timeout' });
  });
  it('ENOTFOUND → nxdomain；解析出空 → nxdomain', async () => {
    lookup.mockRejectedValueOnce(codeErr('ENOTFOUND'));
    expect(await checkUrl('https://gone-0917.example.com/')).toMatchObject({ ok: false, kind: 'dns', dns: 'nxdomain' });
    lookup.mockResolvedValueOnce([]);
    expect(await checkUrl('https://empty-0917.example.com/')).toMatchObject({ ok: false, kind: 'dns', dns: 'nxdomain' });
  });
});

/** 假 context / CDP：只收 Fetch.requestPaused 的回调与 send 调用 */
function fakeContext() {
  const handlers = {};
  const sent = [];
  const cdp = {
    on: (evt, cb) => { handlers[evt] = cb; },
    send: async (method, params) => { sent.push({ method, params }); },
  };
  return {
    sent, handlers,
    ctx: { newCDPSession: async () => cdp, on: () => {}, pages: () => [] },
  };
}

describe('attachSsrfGuard 的记账带 kind', () => {
  it('解析失败 → kind dns + dns 分档；策略拦截 → kind policy；请求照旧 AccessDenied', async () => {
    const f = fakeContext();
    const guard = await attachSsrfGuard(f.ctx, undefined, { proxied: true });
    await guard.armPage({ close: async () => {} });
    lookup.mockRejectedValueOnce(codeErr('EAI_AGAIN'));
    await f.handlers['Fetch.requestPaused']({ requestId: 'r1', request: { url: 'https://fresh-0917.example.com/' } });
    await f.handlers['Fetch.requestPaused']({ requestId: 'r2', request: { url: 'http://127.0.0.1:4001/api' } });
    expect(guard.blocked[0]).toMatchObject({ kind: 'dns', dns: 'timeout', stage: 'request' });
    expect(guard.blocked[1]).toMatchObject({ kind: 'policy', stage: 'request' });
    expect(guard.blocked[1].dns).toBeUndefined();
    const failed = f.sent.filter((x) => x.method === 'Fetch.failRequest').map((x) => x.params.errorReason);
    expect(failed).toEqual(['AccessDenied', 'AccessDenied']);
  });
});

describe('出网代理的 403 页也分档', () => {
  it('明文请求解析超时 → 403 正文说重试，不说不存在', async () => {
    const { port, blocked } = await startBrowseProxy();
    lookup.mockRejectedValueOnce(codeErr('EAI_AGAIN'));
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: 'http://proxy-0917.example.com/' }, (res) => {
        let b = ''; res.setEncoding('utf8');
        res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
      });
      req.on('error', reject); req.end();
    });
    expect(body.status).toBe(403);
    expect(body.text).toMatch(/超时.*重试一次/);
    expect(body.text).not.toContain('不存在');
    expect(blocked.at(-1)).toMatchObject({ target: 'proxy-0917.example.com:80', kind: 'dns', dns: 'timeout' });
  });
});
