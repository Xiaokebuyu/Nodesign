/**
 * 桌面版市场链路整条跑一遍（放在 hosted/ 下：它要同时 import 站点那半，内核目录里的文件不许引 hosted）：本机（local-market.js）→ relay-client → 站点（真的 market-routes，设备令牌换用户）。
 * 站点和本机用的是同一个进程同一个 DB（测试里够用）；本机 plugin 根指到临时目录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import express from 'express';

process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_USER_PLUGINS_DIR = path.join(os.tmpdir(), `nd-local-market-${process.pid}`);

const db = (await import('../engine/runs/store.js')).default;
const { createMarketRouter } = await import('./market-routes.js');
const { _resetForTest, _setPublishState, MARKET_DIR } = await import('./market-store.js');
const { installPluginToRoot } = await import('../lib/plugin-install.js');
const { getUserPluginsRoot } = await import('../engine/agent/plugin-loader.js');

// ── 站点：设备令牌 → 用户 ──
const TOKEN = 'ndk_test.secret';
const remoteUser = (() => {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)').run(id, 'desk_' + id, 'x', 'user');
  return { id, username: 'desk_' + id, role: 'user', plan: 'basic', disabled: false };
})();
const site = express();
site.use('/api/relay/market', createMarketRouter({ userOf: (req) => (req.headers.authorization === `Bearer ${TOKEN}` ? remoteUser : null), source: 'desktop' }));
const siteServer = http.createServer(site);
await new Promise((r) => siteServer.listen(0, '127.0.0.1', r));
process.env.NODESIGN_RELAY_URL = `http://127.0.0.1:${siteServer.address().port}`;
process.env.NODESIGN_RELAY_TOKEN = TOKEN;

// ── 本机：LOCAL_OWNER 在 authGuard 挂 req.user；这里手挂 ──
const localMarketRouter = (await import('../api/local-market.js')).default;
const LOCAL_ID = '_anon';
const local = express();
local.use((req, _res, next) => { req.user = { id: LOCAL_ID, role: 'admin' }; next(); });
local.use('/api/local/market', localMarketRouter);
const localServer = http.createServer(local);
await new Promise((r) => localServer.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${localServer.address().port}/api/local/market`;

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SKILL_MD = `---
name: desk-skill
description: 桌面版打出来的 skill；用在测试
version: 0.3.0
---
# desk

正文
`;

beforeAll(() => { _resetForTest(); _setPublishState('pending'); });   // 这里测的是审核那条流程
afterAll(async () => {
  await new Promise((r) => siteServer.close(r));
  await new Promise((r) => localServer.close(r));
  await fs.rm(MARKET_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(process.env.NODESIGN_USER_PLUGINS_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('桌面版：本机打包发布 → 站点；站点下载 → 本机落盘', () => {
  it('发布本机装着的 skill（带一张图），站点收到的是 plugin-zip、来源记 desktop', async () => {
    const r0 = await installPluginToRoot(Buffer.from(SKILL_MD), getUserPluginsRoot(LOCAL_ID));
    expect(r0.status).toBe(201);

    // 本机没有这个 skill → 404，不会打到站点
    const fd0 = new FormData(); fd0.set('title', 'x'); fd0.set('skillName', 'nope');
    expect((await fetch(base, { method: 'POST', body: fd0 })).status).toBe(404);

    const fd = new FormData();
    fd.set('title', '桌面来的');
    fd.set('note', '说明');
    fd.set('skillName', 'desk-skill');
    fd.append('images', new Blob([PNG_1x1], { type: 'image/png' }), 'shot.png');
    const r = await fetch(base, { method: 'POST', body: fd });
    expect(r.status).toBe(201);
    const { publication } = await r.json();
    expect(publication.source).toBe('desktop');
    expect(publication.skillMode).toBe('plugin-zip');
    expect(publication.skillVersion).toBe('0.3.0');
    expect(publication.author.username).toBe(remoteUser.username);

    // 我的发布：pending；图经本机一跳取得到
    const mine = await (await fetch(`${base}/mine`)).json();
    expect(mine.items.map((i) => i.id)).toEqual([publication.id]);
    const img = await fetch(`${base}/${publication.id}/images/0`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toContain('image/webp');

    // 详情：installedLocally 看的是本机目录（作者本机装着 → true）
    const detail = await (await fetch(`${base}/${publication.id}`)).json();
    expect(detail.installedLocally).toBe(true);
    expect(detail.skillMd).toContain('正文');

    // 撤回
    expect((await fetch(`${base}/${publication.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/${publication.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('安装：站点 approved 的条目下载回来落进本机 plugin 根，并回报站点计数', async () => {
    // 造一条 approved（站点侧直接写：作者是另一个人）
    const { createPublication, reviewPublication, getPublication } = await import('./market-store.js');
    const { validateSkillUpload } = await import('../lib/plugin-validator.js');
    const md = SKILL_MD.replace(/desk-skill/g, 'someone-skill');
    const v = await validateSkillUpload(Buffer.from(md));
    const pub = await createPublication({ userId: 'u_other', skillBuffer: Buffer.from(md), validation: v, skillMd: md, images: [PNG_1x1], title: '别人的', note: null, source: 'web', showcaseId: null });
    expect((await fetch(`${base}/${pub.id}/install`, { method: 'POST' })).status).toBe(404);   // 还没通过
    reviewPublication(pub.id, { state: 'approved', reviewedBy: 'admin' });

    const r = await fetch(`${base}/${pub.id}/install`, { method: 'POST' });
    expect(r.status).toBe(201);
    expect((await r.json()).installed.name).toBe('someone-skill');
    await fs.access(path.join(getUserPluginsRoot(LOCAL_ID), 'someone-skill', 'skills', 'someone-skill', 'SKILL.md'));
    // 回报是异步的，等一拍
    await new Promise((r) => setTimeout(r, 100));
    expect(getPublication(pub.id).installCount).toBe(1);
    // 同名已装 → 409；force 覆盖 → 200
    expect((await fetch(`${base}/${pub.id}/install`, { method: 'POST' })).status).toBe(409);
    expect((await fetch(`${base}/${pub.id}/install?force=1`, { method: 'POST' })).status).toBe(200);
  });

  it('没配 relay：整组 409 RELAY_NOT_CONFIGURED', async () => {
    const saved = process.env.NODESIGN_RELAY_TOKEN;
    delete process.env.NODESIGN_RELAY_TOKEN;
    const r = await fetch(base);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('RELAY_NOT_CONFIGURED');
    process.env.NODESIGN_RELAY_TOKEN = saved;
  });
});
