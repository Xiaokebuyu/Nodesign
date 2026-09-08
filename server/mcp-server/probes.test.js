import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { networkProbe, relayProbe } from './probes.js';

function srv(handler) { return new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port })); }); }

describe('network_probe', () => {
  it('fake-ip 解析出判词；TCP / HTTP 走真连接；代理环境变量只报存在的键', async () => {
    const { s, port } = await srv((req, res) => { res.setHeader('cf-ray', 'abc'); res.end('{"ok":true}'); });
    const saved = process.env.HTTPS_PROXY; process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    try {
      const out = await networkProbe({ url: `http://127.0.0.1:${port}`, resolver: { lookup: async () => [{ address: '198.18.1.236', family: 4 }] } });
      expect(out.dns.addresses).toEqual(['198.18.1.236']);
      expect(out.verdict.join(' ')).toContain('fake-ip');
      expect(out.tcp.ms).toBeGreaterThanOrEqual(0);
      expect(out.tls).toBeNull();
      expect(out.http).toMatchObject({ status: 200, cfRay: 'abc' });
      expect(out.proxyEnv).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    } finally { s.close(); if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved; }
  });
  it('连不上的端口：TCP 与 HTTP 都落错误，判词点名，不抛', async () => {
    const out = await networkProbe({ url: 'http://127.0.0.1:9', timeoutMs: 1500, resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] } });
    expect(out.tcp.error).toBeTruthy();
    expect(out.http.error).toBeTruthy();
    expect(out.verdict.some((v) => v.includes('TCP'))).toBe(true);
  });
});

describe('relay_probe', () => {
  it('没令牌回 configured:false；有令牌打三个端点，401 判词=重新登录，模型清单带锁定原因', async () => {
    expect((await relayProbe({ cfg: null })).configured).toBe(false);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push([url, init.headers.authorization]);
      const p = new URL(url).pathname;
      const body = p.endsWith('/whoami') ? { user: { username: 'u', tier: 'basic' }, capabilities: { subscription: false } }
        : p.endsWith('/models') ? { models: [{ id: 'glm-5.3-flash-merge' }, { id: 'claude-opus-5[1m]', locked: true, lockReason: '订阅腿已关' }] } : { notice: null };
      return { status: 200, json: async () => body };
    };
    const out = await relayProbe({ cfg: { url: 'https://site', token: 'tok' }, fetchImpl });
    expect(calls.map((c) => c[0])).toEqual(['https://site/api/relay/whoami', 'https://site/api/relay/models', 'https://site/api/relay/notice']);
    expect(calls[0][1]).toBe('Bearer tok');
    expect(out.calls['/whoami']).toMatchObject({ status: 200, user: 'u', tier: 'basic' });
    expect(out.calls['/models'].models[1]).toEqual({ id: 'claude-opus-5[1m]', locked: true, reason: '订阅腿已关' });
    expect(out.verdict).toEqual(['relay 正常']);
    const bad = await relayProbe({ cfg: { url: 'https://site', token: 'x' }, fetchImpl: async () => ({ status: 401, json: async () => ({}) }) });
    expect(bad.verdict[0]).toContain('重新登录');
  });
});
