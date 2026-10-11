/**
 * 插槽体检 + .env 白名单读写，对着一个进程内假上游（说 Anthropic 协议）真跑一遍。
 * profile/model-context 都在 import 时读 env，所以先摆好 env 再动态 import（本文件独占一个 worker）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'nd-probe-'));
let fake; let fakeUrl; let mods;

function fakeUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const auth = req.headers['x-api-key'];
      if (auth !== 'sk-fake') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad key' } })); }
      if (req.url.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 7 })); }
      const last = j.messages?.at(-1);
      const hasImage = Array.isArray(last?.content) && last.content.some((b) => b.type === 'image');
      const wantsTool = Array.isArray(j.tools) && j.tools.length;
      const usage = { input_tokens: 5, output_tokens: 2 };
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: j.model, content: [], usage } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'pong' } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
        ev('message_stop', {});
        return res.end();
      }
      const content = wantsTool
        ? [{ type: 'tool_use', id: 'tu1', name: j.tools[0].name, input: { reason: 'because' } }]
        : [{ type: 'text', text: hasImage ? 'Red' : 'pong' }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: j.model, content, stop_reason: wantsTool ? 'tool_use' : 'end_turn', usage }));
    });
  });
}

beforeAll(async () => {
  fake = fakeUpstream();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    upstreams: { fake: { baseUrl: fakeUrl, protocol: 'anthropic', key: 'sk-fake', countTokens: true } },
    models: [{ id: 'fake-model', label: 'Fake', window: 200000, upstream: 'fake', wireModel: 'fake-1' }],
  }));
  process.env.NODESIGN_PROFILE = 'local';
  process.env.NODESIGN_DATA_DIR = dir;
  delete process.env.NODESIGN_MODELS_CONFIG;
  mods = {
    probe: await import('./slot-probe.js'),
    env: await import('../../runtime/local-env.js'),
    ingress: await import('../model-ingress.js'),
  };
});
afterAll(async () => {
  await mods?.ingress.stopIngress?.();
  await new Promise((r) => fake.close(r));
});

describe('probeModel', () => {
  it('外部行穿入口五项全绿；订阅行不探', async () => {
    const r = await mods.probe.probeModel('fake-model', { timeoutMs: 10_000 });
    expect(r.mode).toBe('api');
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(['count_tokens', 'stream', 'text', 'tool_use', 'vision']);
    for (const c of r.checks) expect(c.ok, `${c.id}: ${c.note}`).toBe(true);
    expect(byId.text.note).toMatch(/pong/);
    expect(byId.tool_use.note).toMatch(/because/);
    expect(byId.vision.note).toMatch(/Red/);
    const sub = await mods.probe.probeModel('claude-sonnet-5-5[1m]');
    expect(sub.mode).toBe('subscription');
    expect(sub.checks[0].ok).toBeNull();
  }, 30_000);

  it('钥匙错了：text/stream/tool_use 红并把上游的 401 说出来', async () => {
    // 改上游钥匙：改不了冻结表，改假上游的期望值最省事 —— 让它拒掉 sk-fake
    const saved = fake.listeners('request')[0];
    fake.removeAllListeners('request');
    fake.on('request', (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); });
    try {
      const r = await mods.probe.probeModel('fake-model', { timeoutMs: 10_000, vision: false });
      const core = r.checks.filter((c) => c.level === 'core');
      expect(core.length).toBe(3);
      for (const c of core) { expect(c.ok).toBe(false); expect(c.note).toMatch(/401/); }
    } finally { fake.removeAllListeners('request'); fake.on('request', saved); }
  }, 30_000);
});

describe('local-env', () => {
  it('白名单读写：打码视图、写文件保留别的行、删键、同步 process.env、拒绝白名单外与坏值', () => {
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, '# 注释留着\nSOMETHING_ELSE=keep\nNODESIGN_TAVILY_KEY=tvly-old-1234\n');
    process.env.NODESIGN_TAVILY_KEY = 'tvly-old-1234';
    expect(mods.env.envPath).toBe(envFile);
    const before = mods.env.envView().find((k) => k.key === 'NODESIGN_TAVILY_KEY');
    expect(before).toMatchObject({ set: true, preview: '••••1234' });
    const r = mods.env.setEnvValues({ NODESIGN_TAVILY_KEY: 'tvly-new-9999', ANTHROPIC_API_KEY: 'sk-ant-abcd efgh', NODESIGN_IMAGE_PROVIDER: 'gateway' });
    expect(r.changed.sort()).toEqual(['ANTHROPIC_API_KEY', 'NODESIGN_IMAGE_PROVIDER', 'NODESIGN_TAVILY_KEY']);
    const text = readFileSync(envFile, 'utf8');
    expect(text).toMatch(/^# 注释留着\nSOMETHING_ELSE=keep\nNODESIGN_TAVILY_KEY=tvly-new-9999\n/);
    expect(text).toMatch(/ANTHROPIC_API_KEY="sk-ant-abcd efgh"/);   // 含空格 → 引号
    expect(process.env.NODESIGN_TAVILY_KEY).toBe('tvly-new-9999');
    expect(process.env.NODESIGN_IMAGE_PROVIDER).toBe('gateway');
    mods.env.setEnvValues({ ANTHROPIC_API_KEY: null, NODESIGN_IMAGE_PROVIDER: '' });
    const after = readFileSync(envFile, 'utf8');
    expect(after).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(after).not.toMatch(/NODESIGN_IMAGE_PROVIDER/);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => mods.env.setEnvValues({ DB_PATH: '/x' })).toThrow(/白名单/);
    expect(() => mods.env.setEnvValues({ NODESIGN_IMAGE_PROVIDER: 'dalle' })).toThrow(/只能是/);
    expect(() => mods.env.setEnvValues({ NODESIGN_EXA_KEY: 'a\nb' })).toThrow(/换行/);
    delete process.env.NODESIGN_TAVILY_KEY;
  });
});
