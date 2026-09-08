import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import express from 'express';
import JSZip from 'jszip';

import db from '../engine/runs/store.js';
import { createMarketRouter } from './market-routes.js';
import adminRouter from './admin.js';
import { _resetForTest, featuredSlotsFor, MARKET_DIR, marketOriginPolicy } from './market-store.js';
import { installPluginToRoot } from '../lib/plugin-install.js';
import { getUserPluginsRoot, loadInstalledPlugins } from '../engine/agent/plugin-loader.js';
import { readPluginOrigin, setPluginOriginPolicy } from '../lib/plugin-origin.js';

// 用户级 plugin 根指到临时目录（plugin-loader 认这个 env）
process.env.NODESIGN_USER_PLUGINS_DIR = path.join(os.tmpdir(), `nd-market-plugins-${process.pid}`);

function makeUser(role = 'user') {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)').run(id, 'name_' + id, 'x', role);
  return { id, username: 'name_' + id, role, plan: 'basic', disabled: false };
}
function makeProject(ownerId) {
  const id = `proj_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  db.prepare("INSERT INTO projects (id, name, kind, owner_id) VALUES (?, ?, 'project', ?)").run(id, 'p', ownerId);
  return id;
}

const SKILL_MD = (name) => `---
name: ${name}
description: 手账质感的角色档案站，用在同人分析这种「资料多、想让人慢慢翻」的场合；要做营销页别用它
version: 0.1.0
---

# ${name}

## 判断依据
- 纸张底色用暖灰不用纯白
- 连线用手绘感

## 失效场合
- 需要一眼抓住人的落地页
`;

/** 一张最小 PNG（1x1） */
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const users = new Map();
let server; let base;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = users.get(req.headers['x-user']) || null; next(); });
  app.use('/api/market', createMarketRouter({ userOf: (req) => req.user, source: 'web' }));
  app.use('/api/relay/market', createMarketRouter({ userOf: (req) => req.user, source: 'desktop' }));
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(MARKET_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(process.env.NODESIGN_USER_PLUGINS_DIR, { recursive: true, force: true }).catch(() => {});
});
beforeEach(() => _resetForTest());

const as = (u, p, init = {}) => fetch(base + p, { ...init, headers: { 'x-user': u.id, ...(init.headers || {}) } });
const json = (u, p, method, body) => as(u, p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

function publishForm({ title = '停格', note = '互动视觉小说', skillName, skillZip, images = [PNG_1x1] } = {}) {
  const fd = new FormData();
  fd.set('title', title);
  fd.set('note', note);
  if (skillName) fd.set('skillName', skillName);
  if (skillZip) fd.set('skill', new Blob([skillZip], { type: 'application/zip' }), 'skill.zip');
  for (const img of images) fd.append('images', new Blob([img], { type: 'image/png' }), 'shot.png');
  return fd;
}

async function installSkillFor(user, name) {
  const r = await installPluginToRoot(Buffer.from(SKILL_MD(name)), getUserPluginsRoot(user.id));
  expect([200, 201]).toContain(r.status);
}

describe('市场：发布 → 审核 → 货架 → 安装', () => {
  it('网页发布：从装着的 skill 打包 + 上传参考图 → pending；作者看得到，别人 404；站主审过才上架', async () => {
    const author = makeUser(); const other = makeUser(); const admin = makeUser('admin');
    users.set(author.id, author); users.set(other.id, other); users.set(admin.id, admin);
    await installSkillFor(author, 'dossier-site');

    const r = await as(author, '/api/market', { method: 'POST', body: publishForm({ skillName: 'dossier-site' }) });
    expect(r.status).toBe(201);
    const { publication } = await r.json();
    expect(publication.state).toBe('pending');
    expect(publication.skillName).toBe('dossier-site');
    expect(publication.imageCount).toBe(1);
    expect(publication.author.username).toBe(author.username);

    // 待审的：作者能看，别人 404，货架上没有
    expect((await as(author, `/api/market/${publication.id}`)).status).toBe(200);
    expect((await as(other, `/api/market/${publication.id}`)).status).toBe(404);
    expect((await (await as(other, '/api/market')).json()).items).toHaveLength(0);
    // 别人也装不了
    expect((await as(other, `/api/market/${publication.id}/install`, { method: 'POST' })).status).toBe(404);

    // 站主审核台：pending 里有它，全文在
    const q = await (await as(admin, '/api/admin/market')).json();
    expect(q.items.map((i) => i.id)).toEqual([publication.id]);
    expect(q.counts.pending).toBe(1);
    const detail = await (await as(admin, `/api/admin/market/${publication.id}`)).json();
    expect(detail.skillMd).toContain('失效场合');

    // 通过
    const rv = await json(admin, `/api/admin/market/${publication.id}/review`, 'POST', { state: 'approved', reviewNote: '边界写得清楚' });
    expect(rv.status).toBe(200);
    expect((await rv.json()).publication.state).toBe('approved');

    // 上架了：别人看得到、图取得到、详情不漏内部字段
    const shelf = await (await as(other, '/api/market')).json();
    expect(shelf.items).toHaveLength(1);
    expect(shelf.items[0].installed).toBe(false);
    expect(shelf.items[0]).not.toHaveProperty('skillSha256');
    const img = await as(other, `/api/market/${publication.id}/images/0`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toContain('image/webp');
    expect((await as(other, `/api/market/${publication.id}/images/1`)).status).toBe(404);

    // 别人安装：落进他自己的 plugin 根，货架上 installed 翻真，计数 +1（重装不重复计）
    const inst = await as(other, `/api/market/${publication.id}/install`, { method: 'POST' });
    expect(inst.status).toBe(201);
    expect((await inst.json()).installed.name).toBe('dossier-site');
    await fs.access(path.join(getUserPluginsRoot(other.id), 'dossier-site', 'skills', 'dossier-site', 'SKILL.md'));
    expect((await as(other, `/api/market/${publication.id}/install`, { method: 'POST' })).status).toBe(409);   // 同名已装
    expect((await as(other, `/api/market/${publication.id}/install?force=1`, { method: 'POST' })).status).toBe(200);
    const shelf2 = await (await as(other, '/api/market')).json();
    expect(shelf2.items[0].installed).toBe(true);
    expect(shelf2.items[0].installCount).toBe(1);

    // 装来的那份带来源文件，指回这条发布
    const originDir = path.join(getUserPluginsRoot(other.id), 'dossier-site');
    expect((await readPluginOrigin(originDir))?.publicationId).toBe(publication.id);
    const loadedNames = async () => (await loadInstalledPlugins({ userId: other.id })).plugins.map((p) => path.basename(p.path));
    setPluginOriginPolicy(marketOriginPolicy);
    expect(await loadedNames()).toContain('dossier-site');

    // 作者撤回 → 货架空；已装的那份不动、照常加载（撤回≠撤销）
    expect((await as(author, `/api/market/${publication.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await (await as(other, '/api/market')).json()).items).toHaveLength(0);
    await fs.access(path.join(originDir, 'skills', 'dossier-site', 'SKILL.md'));
    expect(await loadedNames()).toContain('dossier-site');
    expect((await as(author, `/api/market/${publication.id}`, { method: 'DELETE' })).status).toBe(409);

    // 站主撤销 → 文件还在，但下个会话不再加载
    await json(admin, `/api/admin/market/${publication.id}/review`, 'POST', { state: 'revoked', reviewNote: '含注入指令' });
    await fs.access(path.join(originDir, 'skills', 'dossier-site', 'SKILL.md'));
    expect(await loadedNames()).not.toContain('dossier-site');
    setPluginOriginPolicy(null);
  });

  it('桌面版发布：直接给 skill 文件；下载回本机装再记一笔；拒绝没图 / 没 skill / 没过校验的', async () => {
    const author = makeUser(); const other = makeUser(); const admin = makeUser('admin');
    users.set(author.id, author); users.set(other.id, other); users.set(admin.id, admin);

    const zip = new JSZip();
    zip.file('.claude-plugin/plugin.json', JSON.stringify({ name: 'vn-site', version: '0.2.0', description: '互动视觉小说站' }));
    zip.file('skills/vn-site/SKILL.md', SKILL_MD('vn-site'));
    const skillZip = await zip.generateAsync({ type: 'nodebuffer' });

    // 09-08 审出：审核台只展示 SKILL.md，包里多一个文件（references/notes.md）站主就看不到 → 市场只收单 skill、只有 SKILL.md
    const fat = new JSZip();
    fat.file('.claude-plugin/plugin.json', JSON.stringify({ name: 'vn-site', version: '0.2.0', description: 'x' }));
    fat.file('skills/vn-site/SKILL.md', SKILL_MD('vn-site'));
    fat.file('skills/vn-site/references/notes.md', '# 藏在这里的话站主看不到');
    const fatRes = await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ skillZip: await fat.generateAsync({ type: 'nodebuffer' }), images: [PNG_1x1] }) });
    expect(fatRes.status).toBe(400);
    expect((await fatRes.json()).code).toBe('MULTI_FILE_SKILL');
    const two = new JSZip();
    two.file('.claude-plugin/plugin.json', JSON.stringify({ name: 'vn-site', version: '0.2.0', description: 'x' }));
    two.file('skills/vn-site/SKILL.md', SKILL_MD('vn-site'));
    two.file('skills/z-helper/SKILL.md', SKILL_MD('z-helper'));
    const twoRes = await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ skillZip: await two.generateAsync({ type: 'nodebuffer' }), images: [PNG_1x1] }) });
    expect(twoRes.status).toBe(400);
    expect((await twoRes.json()).code).toBe('MULTI_FILE_SKILL');

    expect((await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ skillZip, images: [] }) })).status).toBe(400);   // 没图
    expect((await as(author, '/api/relay/market', { method: 'POST', body: publishForm({}) })).status).toBe(400);                      // 没 skill
    const badZip = await new JSZip().file('skills/x/SKILL.md', 'no frontmatter').generateAsync({ type: 'nodebuffer' });
    const bad = await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ skillZip: badZip }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('VALIDATION_FAILED');

    const r = await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ skillZip, images: [PNG_1x1, PNG_1x1] }) });
    expect(r.status).toBe(201);
    const { publication } = await r.json();
    expect(publication.source).toBe('desktop');
    expect(publication.skillVersion).toBe('0.2.0');
    expect(publication.imageCount).toBe(2);

    // 作者自己能下载自己待审的；站主也能（审原件）；别人要等通过；没过审前谁都不能记「装了」
    expect((await as(author, `/api/relay/market/${publication.id}/download`)).status).toBe(200);
    expect((await as(admin, `/api/relay/market/${publication.id}/download`)).status).toBe(200);
    expect((await as(author, `/api/relay/market/${publication.id}/installed`, { method: 'POST' })).status).toBe(409);
    await json(admin, `/api/admin/market/${publication.id}/review`, 'POST', { state: 'approved', reviewNote: '站主内部批注：写得不错' });
    // 站主的批注不上货架（09-08 审出）
    const shelf = await (await as(other, '/api/relay/market')).json();
    expect(shelf.items.find((x) => x.id === publication.id)).not.toHaveProperty('reviewNote');
    expect(shelf.items.find((x) => x.id === publication.id)).not.toHaveProperty('reviewedAt');
    const dl = await as(other, `/api/relay/market/${publication.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/zip');
    expect(dl.headers.get('x-nd-skill-sha256')).toBe(crypto.createHash('sha256').update(skillZip).digest('hex'));
    expect(Buffer.from(await dl.arrayBuffer()).equals(skillZip)).toBe(true);
    // 本机装成了 → 记一笔
    expect((await as(other, `/api/relay/market/${publication.id}/installed`, { method: 'POST' })).status).toBe(200);
    const mine = await (await as(other, '/api/relay/market')).json();
    expect(mine.items[0].installed).toBe(true);
    expect(mine.items[0].installCount).toBe(1);

    // 站主撤销：货架下架
    await json(admin, `/api/admin/market/${publication.id}/review`, 'POST', { state: 'revoked', reviewNote: '含注入指令' });
    expect((await (await as(other, '/api/relay/market')).json()).items).toHaveLength(0);
    expect((await as(other, `/api/relay/market/${publication.id}`)).status).toBe(404);
  });

  it('精选：只有 approved 能加精；首页位置数按自己的项目数衰减，且排掉自己的', async () => {
    const author = makeUser(); const viewer = makeUser(); const admin = makeUser('admin');
    users.set(author.id, author); users.set(viewer.id, viewer); users.set(admin.id, admin);
    await installSkillFor(author, 'skill-a');
    await installSkillFor(author, 'skill-b');
    const ids = [];
    for (const name of ['skill-a', 'skill-b']) {
      const r = await as(author, '/api/market', { method: 'POST', body: publishForm({ skillName: name, title: name }) });
      ids.push((await r.json()).publication.id);
    }
    // pending 不能加精
    expect((await json(admin, `/api/admin/market/${ids[0]}`, 'PATCH', { featuredRank: 1 })).status).toBe(409);
    for (const id of ids) await json(admin, `/api/admin/market/${id}/review`, 'POST', { state: 'approved' });
    expect((await json(admin, `/api/admin/market/${ids[1]}`, 'PATCH', { featuredRank: 1 })).status).toBe(200);
    expect((await json(admin, `/api/admin/market/${ids[0]}`, 'PATCH', { featuredRank: 5 })).status).toBe(200);

    // 货架：精选靠前，rank 小的在前
    const shelf = await (await as(viewer, '/api/market')).json();
    expect(shelf.items.map((i) => i.id)).toEqual([ids[1], ids[0]]);

    // 首页：viewer 没项目 → 6 个位置，两条都给；作者自己看 → 排掉自己的
    const f0 = await (await as(viewer, '/api/market/featured')).json();
    expect(f0.slots).toBe(6);
    expect(f0.items.map((i) => i.id)).toEqual([ids[1], ids[0]]);
    expect((await (await as(author, '/api/market/featured')).json()).items).toHaveLength(0);

    // viewer 建了 5 个项目 → 只剩 1 个位置；6 个 → 0
    for (let i = 0; i < 5; i++) makeProject(viewer.id);
    const f5 = await (await as(viewer, '/api/market/featured')).json();
    expect(f5.slots).toBe(1);
    expect(f5.items.map((i) => i.id)).toEqual([ids[1]]);
    makeProject(viewer.id);
    expect((await (await as(viewer, '/api/market/featured')).json()).slots).toBe(0);

    // 取消精选；拒绝后 rank 自动清
    await json(admin, `/api/admin/market/${ids[1]}`, 'PATCH', { featuredRank: null });
    await json(admin, `/api/admin/market/${ids[0]}/review`, 'POST', { state: 'rejected' });
    expect((await (await as(admin, '/api/admin/market?state=all')).json()).items.every((i) => i.featuredRank == null)).toBe(true);
  });

  it('featuredSlotsFor：6 减自己的项目数，到 0 为止', () => {
    expect([0, 1, 3, 6, 9].map((n) => featuredSlotsFor(n))).toEqual([6, 5, 3, 0, 0]);
  });
});
