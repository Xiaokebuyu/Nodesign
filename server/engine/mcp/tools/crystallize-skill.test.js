import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

process.env.NODESIGN_USER_PLUGINS_DIR = path.join(os.tmpdir(), `nd-crys-plugins-${process.pid}`);
const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-crys-ws-'));

const db = (await import('../../runs/store.js')).default;
const { makeCrystallizeSkillTool } = await import('./crystallize-skill.js');
const { registerMarketPublisher, _resetMarketPublisher } = await import('../../../lib/market-bridge.js');
const { getUserPluginsRoot } = await import('../../agent/plugin-loader.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let userId, projectId;
beforeAll(async () => {
  userId = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)').run(userId, 'crys_' + userId, 'x', 'user');
  projectId = `proj_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  db.prepare("INSERT INTO projects (id, name, kind, owner_id) VALUES (?, ?, 'project', ?)").run(projectId, 'p', userId);
  await fs.mkdir(path.join(ws, 'shots'), { recursive: true });
  await fs.writeFile(path.join(ws, 'shots', 'a.png'), PNG);
  await fs.writeFile(path.join(ws, 'shots', 'b.webp'), PNG);
  await fs.writeFile(path.join(ws, 'notes.txt'), 'x');
});
afterAll(async () => {
  _resetMarketPublisher();
  await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  await fs.rm(process.env.NODESIGN_USER_PLUGINS_DIR, { recursive: true, force: true }).catch(() => {});
});
const call = (args) => makeCrystallizeSkillTool({ projectId, sessionId: 'sid-x', ctx: { emit() {} }, workspaceRoot: ws }).handler(args, {});
const BODY = '判断依据：'.padEnd(220, '一二三四五六七八九十');

describe('crystallize_skill v2（09-08 晚）：skill 可选、publish + images 经注册口发布、覆盖时版本递进', () => {
  it('只进橱窗（不写 skill）：不要求 description/body', async () => {
    const r = await call({ title: '一张海报', artifactPath: 'site/index.html', showcaseNote: '春节' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('showcase');
    const row = db.prepare('SELECT * FROM showcase WHERE user_id = ? AND artifact_rel = ?').get(userId, 'site/index.html');
    expect(row).toBeTruthy();
    expect(row.skill_name).toBeNull();
  });
  it('给了 name 却没给 body → 报错，不落半个', async () => {
    const r = await call({ name: 'half-skill', title: '半个', artifactPath: 'x.html' });
    expect(r.isError).toBe(true);
  });
  it('publish:true 没注册市场 → 报错；注册后带图发布，图按工作区相对路径读、非图片和越界路径拒', async () => {
    _resetMarketPublisher();
    let r = await call({ title: '发布', artifactPath: 'site/index.html', publish: true, images: ['shots/a.png'] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no market/);
    const seen = [];
    registerMarketPublisher(async (args) => { seen.push(args); return { id: 'pub_test_000001', kind: args.skillName ? 'skill' : 'work' }; });
    r = await call({ title: '发布', artifactPath: 'site/index.html', publish: true, images: ['shots/a.png', 'shots/b.webp'] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('Published to the market as a work');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId, title: '发布', skillName: null });
    expect(seen[0].images.map((i) => i.name)).toEqual(['a.png', 'b.webp']);
    expect(seen[0].images[0].buf.equals(PNG)).toBe(true);
    expect(seen[0].showcaseId).toMatch(/^sc_|^show|./);
    expect((await call({ title: 'x', publish: true, images: ['notes.txt'] })).isError).toBe(true);
    expect((await call({ title: 'x', publish: true, images: ['../../etc/passwd.png'] })).isError).toBe(true);
    expect((await call({ title: 'x', publish: true })).isError).toBe(true);   // 没图
  });
  it('带 skill 发布：skillName 传给 publisher；覆盖时版本 0.1.0 → 0.1.1', async () => {
    const seen = [];
    registerMarketPublisher(async (args) => { seen.push(args); return { id: 'pub_test_000002', kind: 'skill' }; });
    const args = { name: 'warm-poster', title: '暖色海报', description: '暖色调的节庆海报，用在社区活动这类场合；正式公文和冷调品牌别用', body: BODY, artifactPath: 'site/index.html' };
    let r = await call(args);
    expect(r.isError).toBeFalsy();
    const skillMd = (p) => fs.readFile(path.join(getUserPluginsRoot(userId), p, 'skills', p, 'SKILL.md'), 'utf8');
    expect(await skillMd('warm-poster')).toMatch(/^version: 0\.1\.0$/m);
    r = await call({ ...args, overwrite: true, publish: true, images: ['shots/a.png'] });
    expect(r.isError).toBeFalsy();
    expect(await skillMd('warm-poster')).toMatch(/^version: 0\.1\.1$/m);
    expect(seen[0]).toMatchObject({ skillName: 'warm-poster', title: '暖色海报' });
    expect(r.content[0].text).toContain('Published to the market as a skill');
  });
});
