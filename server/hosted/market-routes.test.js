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
import { _resetForTest, _setPublishState, featuredSlotsFor, MARKET_DIR, marketOriginPolicy, DEFAULT_PUBLISH_STATE } from './market-store.js';
import { installPluginToRoot } from '../lib/plugin-install.js';
import { getUserPluginsRoot, loadInstalledPlugins } from '../engine/agent/plugin-loader.js';
import { readPluginOrigin, setPluginOriginPolicy } from '../lib/plugin-origin.js';
import { findUserPluginDir } from '../lib/plugin-pack.js';
import { upsertEntry } from '../lib/showcase-store.js';

// 用户级 plugin 根指到临时目录（plugin-loader 认这个 env）
process.env.NODESIGN_USER_PLUGINS_DIR = path.join(os.tmpdir(), `nd-market-plugins-${process.pid}`);
process.env.PROJECTS_DATA_DIR = process.env.PROJECTS_DATA_DIR || path.join(os.tmpdir(), `nd-market-projects-${process.pid}`);

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

describe('市场：发布即上架（09-08 站主定：初期不审核）', () => {
  it('新发布直接 approved，货架上立刻有；审核台仍能事后下架', async () => {
    expect(DEFAULT_PUBLISH_STATE).toBe('approved');
    const author = makeUser(); const other = makeUser(); const admin = makeUser('admin');
    users.set(author.id, author); users.set(other.id, other); users.set(admin.id, admin);
    const zip = new JSZip();
    zip.file('.claude-plugin/plugin.json', JSON.stringify({ name: 'live-now', version: '1.0.0', description: 'x' }));
    zip.file('skills/live-now/SKILL.md', SKILL_MD('live-now'));
    const r = await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ skillZip: await zip.generateAsync({ type: 'nodebuffer' }), images: [PNG_1x1] }) });
    expect(r.status).toBe(201);
    const { publication } = await r.json();
    expect(publication.state).toBe('approved');
    const shelf = await (await as(other, '/api/relay/market')).json();
    expect(shelf.items.some((x) => x.id === publication.id)).toBe(true);
    await json(admin, `/api/admin/market/${publication.id}/review`, 'POST', { state: 'revoked' });
    expect((await as(other, `/api/relay/market/${publication.id}`)).status).toBe(404);
  });
});

describe('市场：发布 → 审核 → 货架 → 安装（先审后上架那条流程，DEFAULT 改回 pending 时就是它）', () => {
  beforeAll(() => _setPublishState('pending'));
  afterAll(() => _setPublishState(DEFAULT_PUBLISH_STATE));
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
    // v2（09-08 晚）：没 skill 只带图 = 作品，能发（kind=work）；下面 v2 那组 describe 专门测
    const workRes = await as(author, '/api/relay/market', { method: 'POST', body: publishForm({ title: '一张海报' }) });
    expect(workRes.status).toBe(201);
    expect((await workRes.json()).publication).toMatchObject({ kind: 'work', hasSkill: false });
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

    // 补位（09-09）：没加精的 approved 排在加精的后面补进首页；withdrawn/pending 的不算
    await installSkillFor(author, 'skill-c');
    const c = (await (await as(author, '/api/market', { method: 'POST', body: publishForm({ skillName: 'skill-c', title: 'skill-c' }) })).json()).publication.id;
    expect((await (await as(viewer, '/api/market/featured')).json()).items.map((i) => i.id)).toEqual([ids[1], ids[0]]);   // 还是 pending → 不补
    await json(admin, `/api/admin/market/${c}/review`, 'POST', { state: 'approved' });
    expect((await (await as(viewer, '/api/market/featured')).json()).items.map((i) => i.id)).toEqual([ids[1], ids[0], c]);
    await as(author, `/api/market/${c}`, { method: 'DELETE' });

    // viewer 建了 5 个项目 → 只剩 1 个位置；6 个 → 0
    for (let i = 0; i < 5; i++) makeProject(viewer.id);
    const f5 = await (await as(viewer, '/api/market/featured')).json();
    expect(f5.slots).toBe(1);
    expect(f5.items.map((i) => i.id)).toEqual([ids[1]]);   // 只剩 1 位：加精 rank 最小的那条，补位的排不上
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


describe('市场 v2（09-08 晚）：作品发布 / 原地更新 / 照着来一个 / agent 注册口', () => {
  it('作品（无 skill）：发布 201 kind=work；安装与下载 409 NO_SKILL；同一橱窗条目再发 = 原地更新不新增', async () => {
    const author = makeUser(); const other = makeUser();
    users.set(author.id, author); users.set(other.id, other);
    const pid = makeProject(author.id);
    const entry = upsertEntry({ userId: author.id, projectId: pid, taskId: null, artifactRel: 'site/index.html', skillName: null, title: '海报', note: null });
    const fd = publishForm({ title: '春节海报', note: '暖色调' }); fd.set('showcaseId', entry.id); fd.set('kind', 'work');
    const r1 = await as(author, '/api/market', { method: 'POST', body: fd });
    expect(r1.status).toBe(201);
    const pub = (await r1.json()).publication;
    expect(pub).toMatchObject({ kind: 'work', hasSkill: false, imageCount: 1, showcaseId: entry.id });
    expect((await as(other, `/api/market/${pub.id}/install`, { method: 'POST' })).status).toBe(409);
    expect((await (await as(other, `/api/market/${pub.id}/install`, { method: 'POST' })).json()).code).toBe('NO_SKILL');
    expect((await as(other, `/api/market/${pub.id}/download`)).status).toBe(409);
    // 再发：换两张图、改说明 → 同一个 id，200 updated
    const fd2 = publishForm({ title: '春节海报 v2', note: '换了配色', images: [PNG_1x1, PNG_1x1] }); fd2.set('showcaseId', entry.id); fd2.set('kind', 'work');
    const r2 = await as(author, '/api/market', { method: 'POST', body: fd2 });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.updated).toBe(true);
    expect(j2.publication).toMatchObject({ id: pub.id, title: '春节海报 v2', note: '换了配色', imageCount: 2 });
    const shelf = (await (await as(other, '/api/market')).json()).items.filter((p) => p.id === pub.id);
    expect(shelf).toHaveLength(1);
    expect(shelf[0].hasSkill).toBe(false);
  });

  it('skill：同一作者同名 skill 再发 = 原地更新（版本跟着新 SKILL.md），别人的同名不算', async () => {
    const author = makeUser(); const other = makeUser();
    users.set(author.id, author); users.set(other.id, other);
    await installSkillFor(author, 'warm-poster');
    const r1 = await as(author, '/api/market', { method: 'POST', body: publishForm({ skillName: 'warm-poster' }) });
    expect(r1.status).toBe(201);
    const id = (await r1.json()).publication.id;
    // 覆盖装一版 0.1.1 再发
    const bumped = SKILL_MD('warm-poster').replace('version: 0.1.0', 'version: 0.1.1');
    const inst = await installPluginToRoot(Buffer.from(bumped), getUserPluginsRoot(author.id), { force: true });
    expect([200, 201]).toContain(inst.status);
    const r2 = await as(author, '/api/market', { method: 'POST', body: publishForm({ skillName: 'warm-poster', title: '暖色海报 v2' }) });
    expect(r2.status).toBe(200);
    expect((await r2.json()).publication).toMatchObject({ id, skillVersion: '0.1.1', title: '暖色海报 v2' });
    // 别人发同名是另一条
    await installSkillFor(other, 'warm-poster');
    const r3 = await as(other, '/api/market', { method: 'POST', body: publishForm({ skillName: 'warm-poster' }) });
    expect(r3.status).toBe(201);
    expect((await r3.json()).publication.id).not.toBe(id);
  });

  it('照着来一个：网页开新项目、参考图入座、有 skill 就装、回开工提示词；桌面版 409 WEB_ONLY；没过审 409', async () => {
    const author = makeUser(); const me = makeUser();
    users.set(author.id, author); users.set(me.id, me);
    await installSkillFor(author, 'vn-site');
    const r1 = await as(author, '/api/market', { method: 'POST', body: publishForm({ skillName: 'vn-site', title: '互动视觉小说站', note: '像翻一本书', images: [PNG_1x1, PNG_1x1] }) });
    expect(r1.status).toBe(201);
    const pub = (await r1.json()).publication;
    const f = await as(me, `/api/market/${pub.id}/fork`, { method: 'POST' });
    expect(f.status).toBe(201);
    const j = await f.json();
    expect(j.projectId).toMatch(/^proj_/);
    expect(j.images).toEqual([expect.stringMatching(/^参考图\/ref-.*-1\.webp$/), expect.stringMatching(/-2\.webp$/)]);
    expect(j.skillInstalled).toBe(true);
    expect(j.prompt).toContain('互动视觉小说站');
    expect(j.prompt).toContain('先跟我对齐');
    const { getSharedDir } = await import('../projects/workspace.js');
    const dir = path.join(getSharedDir(j.projectId), '参考图');
    expect((await fs.readdir(dir)).length).toBe(2);
    expect(db.prepare('SELECT owner_id, mode FROM projects WHERE id = ?').get(j.projectId)).toMatchObject({ owner_id: me.id, mode: 'design' });
    expect((await findUserPluginDir(me.id, 'vn-site'))).toBeTruthy();
    // 桌面版不提供
    expect((await as(me, `/api/relay/market/${pub.id}/fork`, { method: 'POST' })).status).toBe(409);
    expect((await (await as(me, `/api/relay/market/${pub.id}/fork`, { method: 'POST' })).json()).code).toBe('WEB_ONLY');
  });

  it('agent 注册口：hosted 注册的 publisher 走同一条 publishForUser（作品 / skill 两种），没注册时 publishToMarket 抛 MARKET_UNAVAILABLE', async () => {
    const { registerMarketPublisher, publishToMarket, marketPublisherRegistered, _resetMarketPublisher } = await import('../lib/market-bridge.js');
    const { publishForUser } = await import('./market-routes.js');
    _resetMarketPublisher();
    expect(marketPublisherRegistered()).toBe(false);
    await expect(publishToMarket({ userId: 'x', title: 't', images: [] })).rejects.toMatchObject({ code: 'MARKET_UNAVAILABLE' });
    const author = makeUser(); users.set(author.id, author);
    registerMarketPublisher(async ({ userId, title, note, skillName, images, showcaseId }) => {
      const me = users.get(userId);
      const r = await publishForUser({ me, skillName: skillName || '', kind: skillName ? null : 'work', images, title, note, source: 'web', showcaseId: showcaseId || null });
      if (r.status >= 400) throw Object.assign(new Error(r.body.error), { code: r.body.code });
      return r.body.publication;
    });
    const work = await publishToMarket({ userId: author.id, title: '一张图', note: null, skillName: null, images: [{ buf: PNG_1x1, type: 'image/png', name: 'a.png' }], showcaseId: null });
    expect(work).toMatchObject({ kind: 'work', hasSkill: false, state: 'approved' });
    await installSkillFor(author, 'bridge-skill');
    const sk = await publishToMarket({ userId: author.id, title: '带 skill', note: 'x', skillName: 'bridge-skill', images: [{ buf: PNG_1x1, type: 'image/png', name: 'a.png' }], showcaseId: null });
    expect(sk).toMatchObject({ kind: 'skill', hasSkill: true, skillName: 'bridge-skill' });
    await expect(publishToMarket({ userId: author.id, title: '没图', note: null, skillName: null, images: [], showcaseId: null })).rejects.toMatchObject({ code: 'NO_IMAGE' });
    _resetMarketPublisher();
  });
});
