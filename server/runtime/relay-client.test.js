/** relay-client 对着一个假 relay 跑：目录拉取的成功 / 失败 / 超时，会话登记的抛错口径。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

let mode = 'ok';   // 'ok' | 'unauth' | 'hang' | 'html'
const seen = [];
const fake = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
  if (mode === 'hang') return;   // 不回
  if (mode === 'hang-once') { mode = 'ok'; return; }   // 第一发不回，第二发正常（09-08 连接偶发停顿案）
  if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'); return; }
  if (mode === 'html') { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>bad gateway</html>'); return; }
  if (mode === 'unauth') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: '设备令牌无效' }, code: 'DEVICE_TOKEN_INVALID' })); return; }
  if (req.url === '/api/relay/whoami') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 'u1', username: 'alice', tier: 'basic' }, quota: { kind: 'daily', used: 1, limit: 5 } })); return; }
  if (req.url === '/api/relay/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ id: 'm-api', locked: false }, { id: 'claude-sonnet-5[1m]', locked: true, lockReason: '要订阅' },
    // 09-11 目录带整行：一条拉取那一刻正好在关门时段的（本机据 unavailable 现算，锁要摘掉），一条站主停用的（锁留着）
    { id: 'm-closed', locked: true, lockReason: '关门', lockKind: 'closed', mode: 'api', unavailable: { why: '高峰', tz: 'UTC', windows: ['01:00-04:00'] } },
    { id: 'm-off', locked: true, lockReason: '停用', lockKind: 'disabled', mode: 'api' }], renames: { 'old-id': 'm-api' } })); return; }
  if (req.method === 'POST' && req.url === '/api/relay/sessions') {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = JSON.parse(b);
      if (j.appModel === 'locked-one') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: '没资格' }, code: 'SUBSCRIPTION_REQUIRED' })); return; }
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sid: j.sid, appModel: j.appModel, mode: 'api' }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/relay/login') {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = JSON.parse(b);
      if (j.password !== 'good') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: '用户名或密码错误' }, code: 'BAD_CREDENTIALS' })); return; }
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: 'ndk_new.secret', device: { id: 'new', label: j.label }, user: { username: j.username, tier: 'basic' } }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/relay/logout') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_RELAY_URL = `http://127.0.0.1:${fake.address().port}/`;   // 尾斜杠故意留着，要被剥掉
process.env.NODESIGN_RELAY_TOKEN = 'ndk_test.secret';
const rc = await import('./relay-client.js');

beforeEach(() => { mode = 'ok'; seen.length = 0; });
afterAll(async () => { await new Promise((r) => fake.close(r)); });

describe('relayConfig / relayBaseUrlFor', () => {
  it('地址剥尾斜杠；base URL 带 sid 前缀', () => {
    expect(rc.relayConfig().url.endsWith('/')).toBe(false);
    expect(rc.relayBaseUrlFor('s/1')).toBe(`${rc.relayConfig().url}/api/relay/__nd/s%2F1`);
  });
  it('没令牌 = 没配', () => {
    const t = process.env.NODESIGN_RELAY_TOKEN;
    process.env.NODESIGN_RELAY_TOKEN = '  ';
    expect(rc.relayConfig()).toBeNull();
    expect(rc.relayBaseUrlFor('x')).toBeNull();
    process.env.NODESIGN_RELAY_TOKEN = t;
  });
});

describe('refreshRelayCatalog', () => {
  it('成功：whoami + models 进快照，令牌走 Bearer', async () => {
    const c = await rc.refreshRelayCatalog();
    expect(c.ok).toBe(true);
    expect(c.whoami.user.username).toBe('alice');
    expect(c.models.map((m) => m.id)).toEqual(['m-api', 'claude-sonnet-5[1m]', 'm-closed', 'm-off']);
    expect(rc.relayModelEntry('m-api')).toEqual({ id: 'm-api', locked: false });
    expect(rc.relayModelEntry('claude-sonnet-5[1m]').locked).toBe(true);
    expect(rc.relayModelEntry('nope')).toBeNull();
    expect(seen.every((s) => s.auth === 'Bearer ndk_test.secret')).toBe(true);
  });
  it('401：不抛，ok:false 带 code，目录清空', async () => {
    mode = 'unauth';
    const c = await rc.refreshRelayCatalog();
    expect(c.ok).toBe(false);
    expect(c.configured).toBe(true);
    expect(c.error).toContain('DEVICE_TOKEN_INVALID');
    expect(rc.relayModelEntry('m-api')).toBeNull();
  });
  it('上游回的是 HTML（nginx 502 页）：不炸，error 带状态码', async () => {
    mode = 'html';
    const c = await rc.refreshRelayCatalog();
    expect(c.ok).toBe(false);
    expect(c.error).toContain('502');
  });
  it('09-11：改名表进快照；目录原样存（钟点锁摘不摘按行判，在 model-context，见 model-source.test.js）', async () => {
    const c = await rc.refreshRelayCatalog();
    expect(c.renames).toEqual({ 'old-id': 'm-api' });
    expect(rc.relayModelEntry('m-closed')).toMatchObject({ locked: true, lockKind: 'closed' });
    expect(rc.relayModelEntry('m-off')).toMatchObject({ locked: true, lockReason: '停用' });
  });
  it('09-11 后台刷新（keepOnError）：网络层失败 / 5xx 沿用上一份；4xx 照常清掉；每换一份都通知', async () => {
    const got = [];
    const off = rc.onRelayCatalogChange((c) => got.push(c.ok));
    await rc.refreshRelayCatalog();
    expect(got).toEqual([true]);
    mode = 'html';   // 502
    expect((await rc.refreshRelayCatalog({ keepOnError: true })).ok).toBe(true);
    expect(rc.relayModelEntry('m-api')).toBeTruthy();
    mode = '429';    // 限流 / CF 质询这类 4xx 也不该清掉
    expect((await rc.refreshRelayCatalog({ keepOnError: true })).ok).toBe(true);
    expect(got).toEqual([true]);   // 没换就不通知
    mode = 'unauth';
    expect((await rc.refreshRelayCatalog({ keepOnError: true })).ok).toBe(false);
    expect(got).toEqual([true, false]);
    off();
  });
  it('没配令牌：configured:false，不打网络', async () => {
    const t = process.env.NODESIGN_RELAY_TOKEN;
    delete process.env.NODESIGN_RELAY_TOKEN;
    const c = await rc.refreshRelayCatalog();
    expect(c.configured).toBe(false);
    expect(seen).toHaveLength(0);
    process.env.NODESIGN_RELAY_TOKEN = t;
  });
});

describe('openRelaySession / closeRelaySession', () => {
  it('201 → 返回登记结果', async () => {
    const r = await rc.openRelaySession('sid-abcdefgh', 'm-api');
    expect(r.mode).toBe('api');
  });
  it('⭐ 第一发超时不回 → 换连接重试一次，第二发 201；两发都到了服务端且第二发带 connection: close', async () => {
    const before = seen.length;
    mode = 'hang-once';
    const r = await rc.openRelaySession('sid-stall000', 'm-api', );
    expect(r.sid).toBe('sid-stall000');
    const mine = seen.slice(before).filter((x) => x.url === '/api/relay/sessions');
    expect(mine).toHaveLength(2);
  }, 15000);
  it('403 → 抛错带 code 和服务器的话', async () => {
    await expect(rc.openRelaySession('sid-abcdefgh', 'locked-one')).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', status: 403, message: '没资格' });
  });
  it('close 失败不抛', async () => {
    mode = 'html';
    await expect(rc.closeRelaySession('sid-abcdefgh')).resolves.toBeUndefined();
  });
  // 09-11 验收抓到：会话中途换模型 = 同一个 sid 重启 query，新登记先到、旧 query 的注销后到，旧注销把新登记删了
  it('⭐ 同 sid 重新登记过：拿旧代次注销不发 DELETE；拿新代次才发', async () => {
    const del = () => seen.filter((x) => x.method === 'DELETE').length;
    const a = await rc.openRelaySession('sid-regen-01', 'm-api');
    const b = await rc.openRelaySession('sid-regen-01', 'm-api');   // 换模型重启：同一个 sid
    expect(b.gen).toBeGreaterThan(a.gen);
    await rc.closeRelaySession('sid-regen-01', a.gen);   // 旧 query 的 finally 晚到
    expect(del()).toBe(0);
    await rc.closeRelaySession('sid-regen-01', b.gen);
    expect(del()).toBe(1);
  });
  it('旧注销已经发出去了：新登记等它落地再发（站点先删后登记）', async () => {
    const a = await rc.openRelaySession('sid-regen-02', 'm-api');
    const closing = rc.closeRelaySession('sid-regen-02', a.gen);   // 不等
    await rc.openRelaySession('sid-regen-02', 'm-api');
    await closing;
    const order = seen.filter((x) => x.url.includes('sessions')).map((x) => x.method);
    expect(order).toEqual(['POST', 'DELETE', 'POST']);
  });
});

describe('relayLogin / relayLogout', () => {
  it('登录不带令牌（没令牌也能登），成功拿到令牌和身份', async () => {
    const t = process.env.NODESIGN_RELAY_TOKEN;
    delete process.env.NODESIGN_RELAY_TOKEN;
    const r = await rc.relayLogin({ username: 'alice', password: 'good', label: 'pc' });
    expect(r.token).toBe('ndk_new.secret');
    expect(seen.at(-1).auth).toBeUndefined();
    process.env.NODESIGN_RELAY_TOKEN = t;
  });
  it('错密码 → 抛错带 BAD_CREDENTIALS 和服务器原话', async () => {
    await expect(rc.relayLogin({ username: 'alice', password: 'bad' })).rejects.toMatchObject({ code: 'BAD_CREDENTIALS', status: 401, message: '用户名或密码错误' });
  });
  it('指定站点地址时打到那个地址（尾斜杠剥掉）', async () => {
    const r = await rc.relayLogin({ url: process.env.NODESIGN_RELAY_URL, username: 'a', password: 'good' });
    expect(r.token).toBeTruthy();
  });
  it('退出：吊销失败不抛', async () => {
    mode = 'html';
    expect(await rc.relayLogout()).toBe(false);
  });
});
