import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import db from '../engine/runs/store.js';
import devicesRouter from './devices-api.js';
import { verifyDeviceToken } from './relay/devices.js';

function makeUser() {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)').run(id, id, 'x', 'user');
  return id;
}

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.headers['x-user'] }; next(); });   // 代替 authGuard
  app.use('/api/me/devices', devicesRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/me/devices`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const as = (uid, p = '', init = {}) => fetch(base + p, { ...init, headers: { 'x-user': uid, 'content-type': 'application/json', ...(init.headers || {}) } });

describe('/api/me/devices', () => {
  it('签发：明文只在 POST 响应里；列表看不到；令牌真能过校验', async () => {
    const u = makeUser();
    const r = await as(u, '', { method: 'POST', body: JSON.stringify({ label: '  我的电脑  ' }) });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.token.startsWith('ndk_')).toBe(true);
    expect(j.device.label).toBe('我的电脑');
    expect(verifyDeviceToken(j.token)?.user.id).toBe(u);
    const list = await (await as(u)).json();
    expect(list.devices).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(j.token.split('.')[1]);
  });
  it('吊销：自己的能吊，吊完令牌失效；别人的 404', async () => {
    const a = makeUser(); const b = makeUser();
    const { device, token } = await (await as(a, '', { method: 'POST', body: '{}' })).json();
    expect((await as(b, `/${device.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(verifyDeviceToken(token)).not.toBeNull();
    expect((await as(a, `/${device.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(verifyDeviceToken(token)).toBeNull();
  });
  it('在用的设备封顶 10 台', async () => {
    const u = makeUser();
    for (let i = 0; i < 10; i++) expect((await as(u, '', { method: 'POST', body: '{}' })).status).toBe(201);
    const r = await as(u, '', { method: 'POST', body: '{}' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('TOO_MANY_DEVICES');
  });
});
