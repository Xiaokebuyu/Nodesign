/**
 * 3a / 3b / 3d（09-17，问题库 iss_mtjex6wv_5xhn）：删除进回收站的整条路径 + 回收站接口 + 删除审计。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-projdel-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { default: projectsRouter } = await import('./projects.js');
const store = await import('../projects/store.js');
const { ensureProjectWorkspace, getSharedDir, getProjectWorkspace } = await import('../projects/workspace.js');
const { trashRoot } = await import('../projects/project-trash.js');
const { listDeletionEvents } = await import('../projects/deletion-log.js');
const { softDeleteProject } = await import('./project-delete.js');
const active = await import('../engine/runs/active-runs.js');
const { AsyncQueue } = await import('../lib/async-queue.js');
const { default: db } = await import('../engine/runs/store.js');
const { PROJECT_GONE } = await import('../projects/project-gone.js');

const exists = async (p) => { try { await fs.lstat(p); return true; } catch { return false; } };
const USERS = {
  alice: { id: 'u_alice', role: 'user' },
  bob: { id: 'u_bob', role: 'user' },
  admin: { id: 'u_admin', role: 'admin' },
};
const NO_STOP = {};

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-user']] || null; next(); });
  app.use('/api/projects', projectsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

async function call(method, url, user) {
  const res = await fetch(base + url, { method, headers: { 'x-user': user } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeProject(owner, name) {
  const p = store.createProject({ name, ownerId: USERS[owner].id });
  await ensureProjectWorkspace(p.id);
  await fs.writeFile(path.join(getSharedDir(p.id), '作品.html'), '<h1>作品</h1>', 'utf8');
  return p;
}

describe('DELETE /api/projects/:pid → 回收站', () => {
  it('⭐ 删除：列表里没了、单读 404、进了最近删除；目录在 .trash/；runs 留着；审计记下操作者与大小', async () => {
    const p = await makeProject('alice', '要删的项目');
    db.prepare("INSERT INTO runs (id, skill_id, brief, status, project_id, user_id) VALUES ('run_projdel_1', 's', 'b', 'succeeded', ?, 'u_alice')").run(p.id);
    const del = await call('DELETE', `/api/projects/${p.id}`, 'alice');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, retentionDays: 7, result: 'ok', activeSessions: 0, warning: null });
    expect(Date.parse(del.body.purgeAfter) - Date.parse(del.body.deletedAt)).toBe(7 * 86_400_000);

    const list = await call('GET', '/api/projects', 'alice');
    expect(list.body.projects.map((x) => x.id)).not.toContain(p.id);
    expect(list.body.trashRetentionDays).toBe(7);
    expect((await call('GET', `/api/projects/${p.id}`, 'alice')).status).toBe(404);

    const trash = await call('GET', '/api/projects/trash', 'alice');
    expect(trash.status).toBe(200);
    const row = trash.body.projects.find((x) => x.id === p.id);
    expect(row).toMatchObject({ name: '要删的项目', publishedSites: 0 });
    expect(row.purgeAfter).toBe(del.body.purgeAfter);

    const entries = await fs.readdir(trashRoot());
    const mine = entries.find((n) => n.startsWith(`${p.id}-`));
    expect(await fs.readFile(path.join(trashRoot(), mine, 'shared', '作品.html'), 'utf8')).toBe('<h1>作品</h1>');
    expect((await fs.lstat(getProjectWorkspace(p.id))).isFile()).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM runs WHERE project_id = ?').get(p.id).n).toBe(1);

    const [ev] = listDeletionEvents({ projectId: p.id });
    expect(ev).toMatchObject({
      action: 'delete', reason: 'user', result: 'ok', projectName: '要删的项目', ownerId: 'u_alice',
      actorId: 'u_alice', actorIsAdmin: false, activeSessions: 0,
    });
    expect(ev.workspaceBytes).toBeGreaterThan(0);
    expect(ev.detail).toContain(mine);
  });

  it('⭐ 恢复：回到列表、文件归位、记 restore；再删一次、彻底删除：行与目录都没了、记 purge', async () => {
    const p = await makeProject('alice', '来回折腾');
    await call('DELETE', `/api/projects/${p.id}`, 'alice');
    const back = await call('POST', `/api/projects/trash/${p.id}/restore`, 'alice');
    expect(back.status).toBe(200);
    expect(back.body.project).toMatchObject({ id: p.id, name: '来回折腾', deletedAt: null });
    expect((await call('GET', '/api/projects', 'alice')).body.projects.map((x) => x.id)).toContain(p.id);
    expect(await fs.readFile(path.join(getSharedDir(p.id), '作品.html'), 'utf8')).toBe('<h1>作品</h1>');
    // 恢复后照常能写
    await ensureProjectWorkspace(p.id);

    await call('DELETE', `/api/projects/${p.id}`, 'alice');
    const purge = await call('DELETE', `/api/projects/trash/${p.id}`, 'alice');
    expect(purge).toMatchObject({ status: 200, body: { purged: true } });
    expect(store.getProjectIncludingDeleted(p.id)).toBeNull();
    expect(await exists(getProjectWorkspace(p.id))).toBe(false);
    expect((await fs.readdir(trashRoot())).some((n) => n.startsWith(`${p.id}-`))).toBe(false);
    expect(listDeletionEvents({ projectId: p.id }).map((e) => e.action)).toEqual(['purge', 'delete', 'restore', 'delete']);
    expect((await call('GET', '/api/projects/trash', 'alice')).body.projects.map((x) => x.id)).not.toContain(p.id);
  });

  it('⭐ 只能动自己的：别人删不了、看不见、恢复与彻底删除都是 404', async () => {
    const p = await makeProject('alice', '爱丽丝的');
    expect((await call('DELETE', `/api/projects/${p.id}`, 'bob')).status).toBe(404);
    await call('DELETE', `/api/projects/${p.id}`, 'alice');
    expect((await call('GET', '/api/projects/trash', 'bob')).body.projects.map((x) => x.id)).not.toContain(p.id);
    expect((await call('GET', '/api/projects/trash?all=1', 'bob')).body.projects.map((x) => x.id)).not.toContain(p.id);
    expect((await call('POST', `/api/projects/trash/${p.id}/restore`, 'bob')).status).toBe(404);
    expect((await call('DELETE', `/api/projects/trash/${p.id}`, 'bob')).status).toBe(404);
    expect(store.getProjectIncludingDeleted(p.id)?.deletedAt).toBeTruthy();
    // 活项目不在回收站：恢复 / 彻底删除 404，不会被误删
    const live = await makeProject('alice', '活的');
    expect((await call('DELETE', `/api/projects/trash/${live.id}`, 'alice')).status).toBe(404);
    expect(await exists(getSharedDir(live.id))).toBe(true);
  });

  it('管理员：?all=1 看全站，能恢复别人的，恢复记为管理员操作', async () => {
    const p = await makeProject('bob', '鲍勃的');
    await call('DELETE', `/api/projects/${p.id}`, 'bob');
    expect((await call('GET', '/api/projects/trash', 'admin')).body.projects.map((x) => x.id)).not.toContain(p.id);
    expect((await call('GET', '/api/projects/trash?all=1', 'admin')).body.projects.map((x) => x.id)).toContain(p.id);
    expect((await call('POST', `/api/projects/trash/${p.id}/restore`, 'admin')).status).toBe(200);
    expect(listDeletionEvents({ projectId: p.id })[0]).toMatchObject({ action: 'restore', actorId: 'u_admin', actorIsAdmin: true });
  });

  it('⭐ 审计接口只给管理员', async () => {
    expect((await call('GET', '/api/projects/trash/log', 'alice')).status).toBe(403);
    const r = await call('GET', '/api/projects/trash/log?limit=5', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThan(0);
    expect(r.body.events[0]).toHaveProperty('workspaceBytes');
  });

  it('保留期跟环境变量走（确认框与列表同一个数）', async () => {
    process.env.NODESIGN_TRASH_DAYS = '3';
    try {
      expect((await call('GET', '/api/projects', 'alice')).body.trashRetentionDays).toBe(3);
      expect((await call('GET', '/api/projects/trash', 'alice')).body.retentionDays).toBe(3);
    } finally { delete process.env.NODESIGN_TRASH_DAYS; }
  });
});

describe('softDeleteProject：先关会话、等收尾、再挪目录', () => {
  it('⭐ 在跑的回合：会话被关掉（09-05 那行从没生效），收尾写的文件跟着进回收站，之后的写入被拒', async () => {
    const p = await makeProject('alice', '有回合在跑');
    const SID = 'abcdefab-2222-3333-4444-555555555555';
    const ac = new AbortController();
    const token = active.registerQuerySession(SID, { abortController: ac, inputQueue: new AsyncQueue(), projectId: p.id });
    active.setCurrentTurnRunId(SID, 'run_inflight_1');
    // 模拟 runSession：abort 之后过 200ms 才走完收尾（finishTurn 往工作区提交），然后带 token 注销
    ac.signal.addEventListener('abort', () => {
      setTimeout(async () => {
        await fs.writeFile(path.join(getSharedDir(p.id), '收尾写的.md'), 'late', 'utf8');
        active.unregisterQuerySession(SID, token);
      }, 200);
    });
    const r = await softDeleteProject(p, { actor: USERS.alice, stoppers: NO_STOP });
    expect(ac.signal.aborted).toBe(true);
    expect(active.hasActiveQuerySession(SID)).toBe(false);
    expect(r).toMatchObject({ result: 'ok', activeSessions: 1 });
    const trashDir = store.getProjectIncludingDeleted(p.id).trashDir;
    expect(await fs.readFile(path.join(trashRoot(), trashDir, 'shared', '收尾写的.md'), 'utf8')).toBe('late');
    const [ev] = listDeletionEvents({ projectId: p.id });
    expect(ev).toMatchObject({ activeSessions: 1, result: 'ok' });
    expect(ev.detail).toContain('在跑回合 1');
    // 删完之后迟到的写入：走闸的被拒，绕过闸的 mkdir -p 撞占位文件
    await expect(ensureProjectWorkspace(p.id)).rejects.toMatchObject({ code: PROJECT_GONE });
    const err = await fs.mkdir(path.join(getSharedDir(p.id), '.claude', '.cc-writes'), { recursive: true }).catch((e) => e);
    expect(err?.code).toBe('ENOTDIR');
  });

  it('收尾迟迟不来：等到超时照常挪，结果记 partial', async () => {
    const p = await makeProject('alice', '收尾卡住');
    const SID = 'abcdefab-2222-3333-4444-666666666666';
    active.registerQuerySession(SID, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: p.id });
    const r = await softDeleteProject(p, { actor: USERS.alice, stoppers: NO_STOP, waitMs: 80 });
    expect(r.result).toBe('partial');
    expect(store.getProjectIncludingDeleted(p.id).trashDir).toBeTruthy();
    expect(listDeletionEvents({ projectId: p.id })[0].detail).toMatch(/没退出/);
  });

  it('浏览器 / 演出 / 进程这些常驻件按项目逐个停；某一件停不下来不挡删除', async () => {
    const p = await makeProject('alice', '有常驻件');
    const seen = [];
    const stoppers = {
      browser: async (pid) => { seen.push(['browser', pid]); },
      stages: async () => { throw new Error('stage 卡住了'); },
      processes: async (pid) => { seen.push(['processes', pid]); },
    };
    const r = await softDeleteProject(p, { actor: USERS.alice, stoppers });
    expect(seen).toEqual([['browser', p.id], ['processes', p.id]]);
    expect(r.result).toBe('ok');
    expect(listDeletionEvents({ projectId: p.id })[0].detail).toContain('stage 卡住了');
  });

  it('⭐ Windows 占用挪不动：项目照样删除（进最近删除），工作区留原处，响应带 warning；恢复不受影响', async () => {
    const p = await makeProject('alice', '文件被占用');
    const move = async () => ({ trashDir: null, tombstone: false, moveError: 'EBUSY: resource busy or locked', stray: null });
    const r = await softDeleteProject(p, { actor: USERS.alice, stoppers: NO_STOP, move });
    expect(r.result).toBe('partial');
    expect(r.warning).toMatch(/被占用/);
    expect(store.getProject(p.id)).toBeNull();
    expect(store.getProjectIncludingDeleted(p.id).trashDir).toBeNull();
    const ev = listDeletionEvents({ projectId: p.id })[0];
    expect(ev).toMatchObject({ action: 'delete', result: 'partial' });
    expect(ev.workspaceBytes).toBeGreaterThan(0);   // 留在原处的也量了
    expect((await call('POST', `/api/projects/trash/${p.id}/restore`, 'alice')).status).toBe(200);
    expect(await fs.readFile(path.join(getSharedDir(p.id), '作品.html'), 'utf8')).toBe('<h1>作品</h1>');
  });
});
