/**
 * 演出进程的通路（09-07 修的那条）。
 *
 * 病根：09-05 buildEnv 从 manager 拆出来时自己写了一遍「订阅 / 本机 ingress」两条腿，
 * 09-06 加的第三条腿（站主 relay）只加进了主循环。桌面版默认走 relay，于是演出进程
 * 被指向本机 ingress、取不到内置上游的钥匙、502、CLI 退 1，玩家每说一句都没有回应
 * （问题库 iss_mtqnrdgr_08v2）。
 *
 * 所以这里测的不是「env.js 有没有调某个函数」，是**同一个模型在演出这条路上落到哪个地址**。
 * 对着一个假 relay 真跑一遍（照 runtime/relay-client.test.js 那套），
 * 撤掉修复（改回 resolveModelRoute + getOrStartIngress）这两条会红。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import http from 'node:http';

const seen = [];
const fake = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url });
  if (req.method === 'POST' && req.url === '/api/relay/sessions') {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = JSON.parse(b);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sid: j.sid, appModel: j.appModel, mode: 'api' }));
    });
    return;
  }
  if (req.url === '/api/relay/whoami') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 'u1', username: 'a', tier: 'basic' } })); return; }
  // 目录里放的就是桌面用户实际挑的那一行：本机没有 zenGo 的钥匙，全靠 relay 供着
  if (req.url === '/api/relay/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ id: RELAY_MODEL, locked: false }] })); return; }
  if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end();
});

const RELAY_MODEL = 'deepseek-v4-flash-vision';   // 内置行，上游 zenGo，fastModel 是那条 helper 行
const TOKEN = 'ndk_test.secret';

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const RELAY_URL = `http://127.0.0.1:${fake.address().port}`;

process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_RELAY_URL = RELAY_URL;
process.env.NODESIGN_RELAY_TOKEN = TOKEN;
// ⭐ 这一行是「本机没钥匙」的全部含义：有它就是 BYOK 自己走 ingress，没有才轮得到 relay
delete process.env.NODESIGN_UPSTREAM_ZEN_KEY;

const rc = await import('../../runtime/relay-client.js');
const { buildEnv, releaseUpstream } = await import('./env.js');
const { modelSourceFor } = await import('../agent/model-context.js');
const { stopIngress } = await import('../../lib/model-ingress.js');

await rc.refreshRelayCatalog();

afterAll(async () => { await stopIngress().catch(() => {}); fake.close(); });

const rtOf = () => ({ wsRoot: '/tmp/ws', sdkSid: 'sid-stage-1', bound: null, broadcast() {} });

beforeEach(() => { seen.length = 0; });

describe('演出进程的通路', () => {
  it('前提：这一行在本机确实是 relay 来源（不然下面两条测的是别的东西）', () => {
    expect(modelSourceFor(RELAY_MODEL)).toBe('relay');
  });

  it('relay 来源的模型：地址指站主服务器，不是本机 ingress', async () => {
    const rt = rtOf();
    const env = await buildEnv(rt, RELAY_MODEL, null);
    expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY_URL}/api/relay/__nd/${rt.sdkSid}`);
    expect(env.ANTHROPIC_API_KEY).toBe(TOKEN);
    // 修之前这里是 'nd-ingress-managed' + 一个 127.0.0.1 的本机口
    expect(env.ANTHROPIC_API_KEY).not.toBe('nd-ingress-managed');
    expect(seen.some((r) => r.method === 'POST' && r.url === '/api/relay/sessions')).toBe(true);
  });

  it('演出进程独有的两个键照旧：PWD 钉工作区、工具延迟加载关掉', async () => {
    const rt = rtOf();
    const env = await buildEnv(rt, RELAY_MODEL, null);
    expect(env.PWD).toBe('/tmp/ws');
    expect('ENABLE_TOOL_SEARCH' in env).toBe(false);
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('nodesign-stage/0.0.1');
  });

  it('fastModel 与真实窗口跟着表走（helper 请求认得出自己那一行）', async () => {
    const env = await buildEnv(rtOf(), RELAY_MODEL, null);
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-v4-flash-helper');
    expect(Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)).toBeGreaterThan(0);
  });

  it('releaseUpstream 注销 relay 那边的登记，且可以重复调', async () => {
    const rt = rtOf();
    await buildEnv(rt, RELAY_MODEL, null);
    expect(rt.bound).toBeTruthy();
    releaseUpstream(rt);
    expect(rt.bound).toBeNull();
    releaseUpstream(rt);   // 幂等：stopStage 可能连着调两次
    await new Promise((r) => setTimeout(r, 50));   // 注销不等它回来
    expect(seen.some((r) => r.method === 'DELETE')).toBe(true);
  });
});
