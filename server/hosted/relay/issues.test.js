/**
 * 客户端上报中继：校验 / 落表来源与指纹聚合 / 每设备日限频 / 正文封顶。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

const db = (await import('../../engine/runs/store.js')).default;
const { mintDevice } = await import('./devices.js');
const { createRelayRouter } = await import('./router.js');
const { MAX_PER_DEVICE_PER_DAY, _resetIssueCounts } = await import('./issues.js');
const { listIssues } = await import('../../lib/issues-store.js');

function makeUser() {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, plan, disabled, daily_cost_limit_usd, lifetime_cost_limit_usd) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)')
    .run(id, id, 'x', 'user', 'basic');
  return { id };
}

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use('/api/relay', createRelayRouter({}));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/relay`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => _resetIssueCounts());

const post = (token, body, raw = false) => fetch(base + '/issues', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
const good = (over = {}) => ({ kind: 'friction', source: 'agent', summary: 'screenshot_canvas 在长页上只能 fullPage', detail: '每次自己裁一遍', toolName: 'mcp__nodesign__screenshot_canvas', clientVersion: '0.1.6', platform: 'win32', ...over });

describe('POST /issues', () => {
  it('没令牌 401；kind 不认 400；正文超 16KB 413', async () => {
    const { token } = mintDevice({ userId: makeUser().id, label: 'L' });
    expect((await fetch(base + '/issues', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await post(token, good({ kind: 'rant' }))).status).toBe(400);
    expect((await post(token, good({ summary: '短' }))).status).toBe(400);
    // 超 16KB：readRawBody 直接掐断连接，客户端拿到的是 413 或连接被关（两种都是"没收"）
    const big = await post(token, JSON.stringify(good({ detail: 'x'.repeat(20000) })), true).then((r) => r.status).catch(() => 'closed');
    expect([413, 'closed']).toContain(big);
  });

  it('落站点 issues 表：source=client、带设备与版本头、按指纹跨设备聚合；desktop 来源单列', async () => {
    const u = makeUser();
    const a = mintDevice({ userId: u.id, label: 'Alpha' });
    const b = mintDevice({ userId: makeUser().id, label: 'Beta' });
    const sig = 'sig-' + crypto.randomBytes(3).toString('hex');
    const r1 = await post(a.token, good({ signature: sig }));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    expect(j1.count).toBe(1);
    const r2 = await post(b.token, good({ signature: sig, detail: '另一台也撞了' }));
    expect((await r2.json()).count).toBe(2);
    const row = listIssues({ status: 'all', source: 'client', limit: 500 }).find((x) => x.id === j1.id);
    expect(row.source).toBe('client');
    expect(row.userId).toBe(u.id);
    expect(row.count).toBe(2);
    expect(row.detail.startsWith('[桌面版 v0.1.6 win32 · 设备 Alpha]')).toBe(true);
    expect(row.detail).not.toContain('另一台也撞了');   // 聚合只加计数，正文留第一份

    const d = await post(a.token, { kind: 'bug', source: 'desktop', summary: '更新模块没起来：failed:ENOENT', detail: 'electron-updater load failed' });
    expect(d.status).toBe(201);
    const dj = await d.json();
    const drow = listIssues({ status: 'all', source: 'desktop', limit: 500 }).find((x) => x.id === dj.id);
    expect(drow.source).toBe('desktop');
    expect(drow.kind).toBe('bug');
  });

  it('每设备每天封顶：第 N+1 条 429，别的设备不受影响', async () => {
    const a = mintDevice({ userId: makeUser().id, label: 'A' });
    const b = mintDevice({ userId: makeUser().id, label: 'B' });
    for (let i = 0; i < MAX_PER_DEVICE_PER_DAY; i++) {
      expect((await post(a.token, good({ summary: `第 ${i} 条不一样的抱怨 xxxxx`, signature: `s${i}` }))).status).toBe(201);
    }
    expect((await post(a.token, good({ signature: 'over' }))).status).toBe(429);
    expect((await post(b.token, good({ signature: 'other-device' }))).status).toBe(201);
  });
});
