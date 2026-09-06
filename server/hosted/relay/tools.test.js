/**
 * relay 工具中继：网关替桌面版搜 / 出图。供应商那一步用假函数顶（真搜索 / 真生图不进测试），
 * 测的是闸（档位 / 日额度）、参数校验、参考图落成临时文件、出了图才记账、错误形状。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';

process.env.NODESIGN_IMAGE_PRICE_USD = '0.2';
const db = (await import('../../engine/runs/store.js')).default;
const { mintDevice } = await import('./devices.js');
const { createRelayRouter } = await import('./router.js');
const { installRelayUsageSource, _resetInstalled } = await import('./usage.js');
const { _resetUsageSources } = await import('../../lib/quota.js');
const { ProviderError } = await import('../../engine/mcp/tools/web-search-providers.js');

function makeUser({ plan = 'basic', daily = null } = {}) {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, plan, disabled, daily_cost_limit_usd, lifetime_cost_limit_usd) VALUES (?, ?, ?, ?, ?, 0, ?, NULL)')
    .run(id, id, 'x', 'user', plan, daily);
  return { id };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const search = vi.fn(async ({ query, provider, count, includeImages }) => ({ providerId: 'tavily', providerNote: '', hits: [{ title: `hit for ${query}`, url: 'https://x', snippet: `${provider}/${count}/${includeImages}` }], images: [] }));
const seenRefs = [];
const produce = vi.fn(async ({ refs, codexOutAbs, route, modelId }) => {
  for (const r of refs) seenRefs.push({ exists: fs.existsSync(r.abs), bytes: fs.readFileSync(r.abs), mimeType: r.mimeType, abs: r.abs });
  return { imgBuf: PNG, outMime: 'image/png', accompanyText: `${route}:${modelId}:${codexOutAbs.endsWith('out.png')}`, response: { candidates: [{ groundingMetadata: { webSearchQueries: ['q'] } }] } };
});
let imageRoute = 'codex';

let server; let base;
beforeAll(async () => {
  _resetUsageSources(); _resetInstalled(); installRelayUsageSource();
  const app = express();
  app.use('/api/relay', createRelayRouter({ tools: { search, produce, imageRouteOf: () => imageRoute } }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/relay`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); delete process.env.NODESIGN_IMAGE_PRICE_USD; });

const post = (token, p, body) => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const rows = (userId) => db.prepare('SELECT model, cost_usd FROM relay_usage WHERE user_id = ? ORDER BY id').all(userId);

describe('whoami.tools', () => {
  it('basic 档：搜索和生图都由网关代跑', async () => {
    const { token } = mintDevice({ userId: makeUser().id });
    const j = await (await fetch(base + '/whoami', { headers: { authorization: `Bearer ${token}` } })).json();
    expect(j.tools).toEqual({ web_search: true, generate_image: true });
  });
});

describe('POST /tools/web_search', () => {
  it('透传参数，回 runWebSearch 的形状', async () => {
    const { token } = mintDevice({ userId: makeUser().id });
    const r = await post(token, '/tools/web_search', { query: '北京 天气 2026', provider: 'baidu', count: 3, includeImages: true });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.providerId).toBe('tavily');
    expect(j.hits[0].snippet).toBe('baidu/3/true');
    expect(search).toHaveBeenCalledWith({ query: '北京 天气 2026', provider: 'baidu', count: 3, includeImages: true });
  });
  it('参数校验：query 太短 400，provider 不认识 400；供应商 429 → 502 带换一家的提示', async () => {
    const { token } = mintDevice({ userId: makeUser().id });
    expect((await post(token, '/tools/web_search', { query: 'a' })).status).toBe(400);
    expect((await post(token, '/tools/web_search', { query: 'abc', provider: 'bing' })).status).toBe(400);
    search.mockImplementationOnce(async () => { throw new ProviderError('tavily', 429, 'quota'); });
    const r = await post(token, '/tools/web_search', { query: 'abc' });
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.code).toBe('SEARCH_FAILED');
    expect(j.error.message).toContain('换一家');
  });
  it('站点这边没配任何 key（runWebSearch 回 error）→ 503', async () => {
    const { token } = mintDevice({ userId: makeUser().id });
    search.mockImplementationOnce(async () => ({ error: 'web_search failed: no provider configured' }));
    const r = await post(token, '/tools/web_search', { query: 'abc' });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('SEARCH_UNAVAILABLE');
  });
});

describe('POST /tools/generate_image', () => {
  it('出图期间定时发空格穿 Cloudflare 的 100 秒：慢出图的响应前面有空白，JSON 照样能解', async () => {
    const { token } = mintDevice({ userId: makeUser({ daily: 5 }).id });
    process.env.NODESIGN_RELAY_HEARTBEAT_MS = '40';
    produce.mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 250)); return { imgBuf: PNG, outMime: 'image/png', accompanyText: null, response: null }; });
    const r = await post(token, '/tools/generate_image', { prompt: 'slow' });
    delete process.env.NODESIGN_RELAY_HEARTBEAT_MS;
    const text = await r.text();
    expect(text.length - text.trimStart().length).toBeGreaterThanOrEqual(3);   // 至少三个心跳
    expect(JSON.parse(text).mimeType).toBe('image/png');
    expect(r.headers.get('x-accel-buffering')).toBe('no');
  });
  it('参考图落成临时文件交给 produceImage，出图后回 base64 + grounding，账本记 $0.20', async () => {
    const user = makeUser({ daily: 5 });
    const { token } = mintDevice({ userId: user.id });
    const ref = Buffer.from('fake-jpeg-bytes');
    const r = await post(token, '/tools/generate_image', { prompt: 'a cat', model: 'pro', refs: [{ mimeType: 'image/jpeg', base64: ref.toString('base64') }] });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const j = await r.json();
    expect(Buffer.from(j.base64, 'base64').equals(PNG)).toBe(true);
    expect(j.mimeType).toBe('image/png');
    expect(j.provider).toBe('codex');
    expect(j.accompanyText).toBe('codex:gemini-3-pro-image-preview:true');
    expect(j.grounding).toEqual({ webSearchQueries: ['q'] });
    expect(j.costUsd).toBe(0.2);
    expect(seenRefs.at(-1)).toMatchObject({ exists: true, mimeType: 'image/jpeg' });
    expect(seenRefs.at(-1).bytes.equals(ref)).toBe(true);
    expect(seenRefs.at(-1).abs.endsWith('.jpg')).toBe(true);
    expect(fs.existsSync(seenRefs.at(-1).abs)).toBe(false);   // 临时目录用完清掉
    expect(rows(user.id)).toEqual([{ model: 'generate_image', cost_usd: 0.2 }]);
  });
  it('日额度：$0.1 的账号出一张（$0.2）之后第二张 429，且不再记账', async () => {
    const user = makeUser({ daily: 0.1 });
    const { token } = mintDevice({ userId: user.id });
    expect((await post(token, '/tools/generate_image', { prompt: 'x' })).status).toBe(200);
    const r = await post(token, '/tools/generate_image', { prompt: 'y' });
    expect(r.status).toBe(429);
    const j = await r.json();
    expect(j.code).toBe('QUOTA_EXCEEDED');
    expect(j.quota).toMatchObject({ kind: 'daily', limit: 0.1 });
    expect(rows(user.id)).toHaveLength(1);
  });
  it('出图失败（produceImage 抛 stage）→ 502 带阶段，不记账；站点没通道 → 503', async () => {
    const user = makeUser({ daily: 5 });
    const { token } = mintDevice({ userId: user.id });
    produce.mockImplementationOnce(async () => { throw Object.assign(new Error('codex exited 1'), { stage: 'codex' }); });
    const r = await post(token, '/tools/generate_image', { prompt: 'x' });
    expect(r.status).toBe(200);   // 头已经为心跳发出去了：失败是 200 + 错误形状
    const j = await r.json();
    expect(j.type).toBe('error');
    expect(j.code).toBe('IMAGE_FAILED');
    expect(j.error.message).toBe('generate_image codex error: codex exited 1');
    expect(rows(user.id)).toEqual([]);
    imageRoute = null;
    expect((await post(token, '/tools/generate_image', { prompt: 'x' })).status).toBe(503);
    imageRoute = 'codex';
  });
  it('参数校验：没 prompt 400、model 不认识 400、refs 的 mime 不支持 400', async () => {
    const { token } = mintDevice({ userId: makeUser().id });
    expect((await post(token, '/tools/generate_image', {})).status).toBe(400);
    expect((await post(token, '/tools/generate_image', { prompt: 'x', model: 'ultra' })).status).toBe(400);
    const r = await post(token, '/tools/generate_image', { prompt: 'x', refs: [{ mimeType: 'text/plain', base64: 'aGk=' }] });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('BAD_REFS');
  });
});
