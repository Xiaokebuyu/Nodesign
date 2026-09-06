/**
 * 桌面版这半：本机没钥匙、登录了站点 → web_search / generate_image 的供应商那步走网关，其余在本机。
 * 假网关记下收到的请求并回固定结果；工具本体是真的（排版 / 落盘 / 缩略图都真跑）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

process.env.NODESIGN_PROFILE = 'local';   // relayConfig 只在 local profile 下有值
process.env.NODESIGN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tools-data-'));

for (const k of ['NODESIGN_TAVILY_KEY', 'NODESIGN_EXA_KEY', 'NODESIGN_BAIDU_QIANFAN_KEY', 'NODESIGN_ZHIPU_KEY', 'NODESIGN_GATEWAY_KEY']) delete process.env[k];
process.env.NODESIGN_IMAGE_PROVIDER = 'gateway';   // 没 key → 本机不能出图（不看这台机器有没有 codex）

const seen = [];
let mode = 'ok';
const PNG = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
const relay = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (mode === 'denied') return json(403, { type: 'error', error: { type: 'permission_error', message: 'basic 档每天最多 60 次联网搜索，今天已用完' }, code: 'TIER_DENIED' });
    if (req.url === '/api/relay/tools/web_search') return json(200, { providerId: 'baidu', providerNote: '', hits: [{ title: '故宫', url: 'https://example.com/gugong', source: 'example.com', snippet: '紫禁城…' }], images: [] });
    if (req.url === '/api/relay/tools/generate_image') return json(200, { provider: 'codex', base64: PNG.toString('base64'), mimeType: 'image/png', accompanyText: null, grounding: null, costUsd: 0.2 });
    json(404, { code: 'NOT_FOUND' });
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
process.env.NODESIGN_RELAY_URL = `http://127.0.0.1:${relay.address().port}`;
process.env.NODESIGN_RELAY_TOKEN = 'ndk_test.secret';

const rc = await import('../../../runtime/relay-client.js');
const { searchRoute, imageRoute } = await import('./relay-tools.js');
const { makeWebSearchTool } = await import('./web-search.js');
const { makeGenerateImageTool } = await import('./generate-image.js');
const { pickSearchProvider } = await import('./web-search-providers.js');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tools-ws-'));
afterAll(async () => { await new Promise((r) => relay.close(r)); fs.rmSync(ws, { recursive: true, force: true }); });
beforeEach(() => { seen.length = 0; mode = 'ok'; rc._setRelayCatalog({ configured: true, ok: true, at: Date.now(), error: null, whoami: { tools: { web_search: true, generate_image: true } }, models: [] }); });

describe('选路', () => {
  it('本机没钥匙 + 网关说给 → relay；网关不给 / 目录没拉到 → null；本机有 key → local', () => {
    expect(searchRoute()).toBe('relay');
    expect(imageRoute()).toBe('relay');
    rc._setRelayCatalog({ configured: true, ok: true, whoami: { tools: { web_search: false, generate_image: false } }, models: [] });
    expect(searchRoute()).toBeNull();
    expect(imageRoute()).toBeNull();
    rc._setRelayCatalog({ configured: true, ok: false, whoami: null, models: [] });
    expect(searchRoute()).toBeNull();
    process.env.NODESIGN_TAVILY_KEY = 'tvly-x';
    expect(searchRoute()).toBe('local');
    delete process.env.NODESIGN_TAVILY_KEY;
  });
  it('pickSearchProvider：按语言选家，点名没 key 换配了的，include_images 剔掉 zhipu', () => {
    expect(pickSearchProvider({ query: '北京' })).toMatchObject({ error: expect.stringContaining('no provider configured') });
    process.env.NODESIGN_ZHIPU_KEY = 'z'; process.env.NODESIGN_TAVILY_KEY = 't';
    expect(pickSearchProvider({ query: 'hello' })).toEqual({ providerId: 'tavily', providerNote: '' });
    expect(pickSearchProvider({ query: '北京' })).toEqual({ providerId: 'tavily', providerNote: '' });   // baidu 没 key，CJK 顺位到 tavily
    expect(pickSearchProvider({ query: 'x', provider: 'baidu' }).providerNote).toContain('已换用 tavily');
    expect(pickSearchProvider({ query: 'x', provider: 'zhipu' })).toEqual({ providerId: 'zhipu', providerNote: '' });
    expect(pickSearchProvider({ query: 'x', provider: 'zhipu', includeImages: true }).error).toContain('does not support image');
    delete process.env.NODESIGN_TAVILY_KEY;
    expect(pickSearchProvider({ query: 'x', includeImages: true }).error).toContain('image-capable');   // 只剩 zhipu 不算
    delete process.env.NODESIGN_ZHIPU_KEY;
  });
});

describe('web_search 走网关', () => {
  it('请求带令牌到 /tools/web_search，结果按工具本体排版', async () => {
    const t = makeWebSearchTool({ workspaceRoot: ws, ctx: { emit() {} } });
    const r = await t.handler({ query: '故宫 2026', count: 3 }, {});
    expect(r.isError).toBeFalsy();
    expect(seen[0]).toMatchObject({ url: '/api/relay/tools/web_search', auth: 'Bearer ndk_test.secret', body: { query: '故宫 2026', provider: 'auto', count: 3, includeImages: false } });
    expect(r.content[0].text).toContain('Search results (baidu, 1 hits)');
    expect(r.content[0].text).toContain('https://example.com/gugong');
  });
  it('网关拒绝（档位 / 日上限）→ 工具回 isError 且把网关那句话带给 agent', async () => {
    mode = 'denied';
    const t = makeWebSearchTool({ workspaceRoot: ws });
    const r = await t.handler({ query: '故宫 2026' }, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('TIER_DENIED');
    expect(r.content[0].text).toContain('今天已用完');
  });
});

describe('generate_image 走网关', () => {
  it('参考图以 base64 上传；回来的图落进 assets/generated 并出缩略图', async () => {
    const refDir = path.join(ws, 'assets', 'references'); fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'ref.png'), PNG);
    const events = [];
    const t = makeGenerateImageTool({ workspaceRoot: ws, ctx: { emit: (e) => events.push(e), sessionId: 's1' } });
    const r = await t.handler({ prompt: 'a red bar', aspectRatio: '16:9', referenceImages: ['assets/references/ref.png'], outputName: 'red-bar' }, {});
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    expect(seen[0].url).toBe('/api/relay/tools/generate_image');
    expect(seen[0].body).toMatchObject({ prompt: 'a red bar', aspectRatio: '16:9', model: 'flash', isVariation: false });
    expect(seen[0].body.refs).toHaveLength(1);
    expect(Buffer.from(seen[0].body.refs[0].base64, 'base64').equals(PNG)).toBe(true);
    const out = path.join(ws, 'assets', 'generated', 'red-bar.png');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out).equals(PNG)).toBe(true);
    expect(fs.existsSync(path.join(ws, 'assets', 'generated', '.thumbnails', 'red-bar.thumb.webp'))).toBe(true);
    expect(r.content.some((b) => b.type === 'image')).toBe(true);
    expect(r.content[0].text).toContain('red-bar.png');
    const meta = JSON.parse(fs.readFileSync(path.join(ws, 'assets', 'generated', '.meta', 'red-bar.json'), 'utf8'));
    expect(meta.provider).toBe('codex');   // 网关报它那边真用的那家
  });
  it('网关不给生图 → 工具说没有通道，不发请求', async () => {
    rc._setRelayCatalog({ configured: true, ok: true, whoami: { tools: { web_search: true, generate_image: false } }, models: [] });
    const t = makeGenerateImageTool({ workspaceRoot: ws, ctx: {} });
    const r = await t.handler({ prompt: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('no image provider configured');
    expect(seen).toHaveLength(0);
  });
});
