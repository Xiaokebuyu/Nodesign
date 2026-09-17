/**
 * 3a（09-17，问题库 iss_mtjex6wv_5xhn）：回收站的磁盘一半 + 恢复 / 彻底删除 / 到期清理。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-trash-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const store = await import('./store.js');
const { ensureProjectWorkspace, getProjectWorkspace, getSharedDir, PROJECTS_DATA_ROOT } = await import('./workspace.js');
const trash = await import('./project-trash.js');
const life = await import('./trash-lifecycle.js');
const { listDeletionEvents } = await import('./deletion-log.js');
const showcase = await import('../lib/showcase-store.js');
const { default: db } = await import('../engine/runs/store.js');
const { openFolder } = await import('./folder.js');

const exists = async (p) => { try { await fs.lstat(p); return true; } catch { return false; } };

async function liveProject(name, ownerId = 'u_t') {
  const p = store.createProject({ name, ownerId });
  await ensureProjectWorkspace(p.id);
  await fs.writeFile(path.join(getSharedDir(p.id), '作品.html'), '<h1>hi</h1>', 'utf8');
  return p;
}
async function softDelete(p, at) {
  store.markProjectDeleted(p.id, at);
  const moved = await trash.moveWorkspaceToTrash(p.id, at ? { now: new Date(at) } : {});
  store.setProjectTrashDir(p.id, moved.trashDir);
  return moved;
}

describe('保留期与目录名', () => {
  it('NODESIGN_TRASH_DAYS：默认 7，非法回落默认，上限 365，0 允许', () => {
    expect(trash.trashRetentionDays({})).toBe(7);
    expect(trash.trashRetentionDays({ NODESIGN_TRASH_DAYS: '30' })).toBe(30);
    expect(trash.trashRetentionDays({ NODESIGN_TRASH_DAYS: 'abc' })).toBe(7);
    expect(trash.trashRetentionDays({ NODESIGN_TRASH_DAYS: '-1' })).toBe(7);
    expect(trash.trashRetentionDays({ NODESIGN_TRASH_DAYS: '9999' })).toBe(365);
    expect(trash.trashRetentionDays({ NODESIGN_TRASH_DAYS: '0' })).toBe(0);
    expect(trash.purgeAfter('2026-09-17T00:00:00.000Z', 7)).toBe('2026-09-24T00:00:00.000Z');
  });

  it('目录名 <pid>-<时间>：能解回 pid 与时间；带分隔符 / .. 的名字拒绝', () => {
    const name = trash.trashEntryName('proj_abc123_xy', new Date('2026-09-17T10:11:12.345Z'));
    expect(name).toBe('proj_abc123_xy-20260917T101112345Z');
    expect(trash.parseTrashEntryName(name)).toEqual({ projectId: 'proj_abc123_xy', at: '2026-09-17T10:11:12.345Z' });
    expect(trash.parseTrashEntryName(`${name}-stray`)?.projectId).toBe('proj_abc123_xy');
    expect(() => trash.trashPathOf('../x')).toThrow();
    expect(() => trash.trashPathOf('proj_abc123_xy-20260917T101112345Z/../../etc')).toThrow();
    expect(trash.trashRoot()).toBe(path.join(PROJECTS_DATA_ROOT, '.trash'));
  });
});

describe('挪进回收站 / 挪回来', () => {
  it('⭐ 整个项目目录进 .trash/，原路径是占位文件；恢复后内容一字不差、占位文件消失', async () => {
    const p = await liveProject('挪来挪去');
    const moved = await softDelete(p);
    expect(moved).toMatchObject({ tombstone: true, moveError: null });
    const inTrash = path.join(trash.trashRoot(), moved.trashDir);
    expect(await fs.readFile(path.join(inTrash, 'shared', '作品.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect((await fs.lstat(getProjectWorkspace(p.id))).isFile()).toBe(true);
    const r = await trash.restoreWorkspaceFromTrash(p.id, moved.trashDir);
    expect(r).toEqual({ restored: true, stray: null });
    expect(await fs.readFile(path.join(getSharedDir(p.id), '作品.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(await exists(inTrash)).toBe(false);
  });

  it('删除时没有工作区目录（文件夹项目常见）：只立占位文件，恢复时只清占位', async () => {
    const p = store.createProject({ name: '无目录', ownerId: 'u_t' });
    const moved = await trash.moveWorkspaceToTrash(p.id);
    expect(moved).toMatchObject({ trashDir: null, tombstone: true, moveError: null });
    await trash.restoreWorkspaceFromTrash(p.id, null);
    expect(await exists(getProjectWorkspace(p.id))).toBe(false);
  });

  it('恢复时原路径上冒出了目录（迟到写入）：它被挪进回收站留着，不覆盖也不丢', async () => {
    const p = await liveProject('迟到目录');
    const moved = await softDelete(p);
    await trash.removeTombstone(p.id);
    await fs.mkdir(path.join(getSharedDir(p.id), '.claude'), { recursive: true });
    const r = await trash.restoreWorkspaceFromTrash(p.id, moved.trashDir);
    expect(r.stray).toMatch(/-stray$/);
    expect(await exists(path.join(trash.trashRoot(), r.stray, 'shared', '.claude'))).toBe(true);
    expect(await exists(path.join(getSharedDir(p.id), '作品.html'))).toBe(true);
  });

  it('⭐ Windows 占用：EBUSY 退避重试后成功', async () => {
    let calls = 0;
    const rename = vi.fn(async (a, b) => { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.rename(a, b); });
    const sleep = vi.fn(async () => {});
    const src = path.join(tmp, 'rn-src'); const dst = path.join(tmp, 'rn-dst');
    await fs.mkdir(src);
    await trash.renameWithRetry(src, dst, { rename, sleep });
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    expect(await exists(dst)).toBe(true);
  });

  it('⭐ 一直占用：重试用完报错；挪不动时工作区留在原处、不立占位文件', async () => {
    const rename = vi.fn(async () => { throw Object.assign(new Error('resource busy or locked'), { code: 'EPERM' }); });
    const sleep = async () => {};
    await expect(trash.renameWithRetry('a', 'b', { rename, sleep, delays: [1, 1] })).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(3);
    const p = await liveProject('一直占用');
    const moved = await trash.moveWorkspaceToTrash(p.id, { renameOpts: { rename, sleep, delays: [1] } });
    expect(moved.trashDir).toBeNull();
    expect(moved.moveError).toMatch(/EPERM/);
    expect(moved.tombstone).toBe(false);
    expect((await fs.lstat(getProjectWorkspace(p.id))).isDirectory()).toBe(true);
  });

  it('不可重试的错误码不重试', async () => {
    const rename = vi.fn(async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    await expect(trash.renameWithRetry('a', 'b', { rename, sleep: async () => {} })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('measureDir：字节数与文件数；超过条目上限标 truncated', async () => {
    const d = path.join(tmp, 'measure');
    await fs.mkdir(path.join(d, 'sub'), { recursive: true });
    await fs.writeFile(path.join(d, 'a.txt'), '12345');
    await fs.writeFile(path.join(d, 'sub', 'b.txt'), '123');
    expect(await trash.measureDir(d)).toEqual({ bytes: 8, files: 2, truncated: false });
    expect((await trash.measureDir(d, { maxEntries: 1 })).truncated).toBe(true);
  });
});

describe('恢复 / 彻底删除（库 + 磁盘 + 审计）', () => {
  it('⭐ 恢复：项目回到默认查询、工作区归位、记一条 restore', async () => {
    const p = await liveProject('要恢复的');
    await softDelete(p);
    expect(store.getProject(p.id)).toBeNull();
    const back = await life.restoreDeletedProject(p.id, { actor: { id: 'u_t', role: 'user' } });
    expect(back.id).toBe(p.id);
    expect(back.deletedAt).toBeNull();
    expect(await exists(path.join(getSharedDir(p.id), '作品.html'))).toBe(true);
    const [ev] = listDeletionEvents({ projectId: p.id });
    expect(ev).toMatchObject({ action: 'restore', result: 'ok', actorId: 'u_t', actorIsAdmin: false, projectName: '要恢复的' });
  });

  it('不在回收站的项目不能恢复 / 彻底删除', async () => {
    const p = await liveProject('活着的');
    await expect(life.restoreDeletedProject(p.id)).rejects.toMatchObject({ code: 'NOT_IN_TRASH', status: 404 });
    await expect(life.purgeDeletedProject(p.id)).rejects.toMatchObject({ code: 'NOT_IN_TRASH' });
    expect(await exists(getSharedDir(p.id))).toBe(true);
  });

  it('⭐ 彻底删除：回收目录、占位文件、项目行、橱窗卡片都没了；runs 留着；记一条 purge 带大小', async () => {
    const p = await liveProject('要彻底删的');
    db.prepare("INSERT INTO runs (id, skill_id, brief, status, project_id, user_id) VALUES ('run_trash_keep1', 's', 'b', 'succeeded', ?, 'u_t')").run(p.id);
    showcase.upsertEntry({ userId: 'u_t', projectId: p.id, artifactRel: '作品.html', title: '橱窗' });
    const moved = await softDelete(p);
    // 保留期内橱窗卡片留着（恢复后照常可用）
    expect(showcase.listEntries('u_t').some((e) => e.projectId === p.id)).toBe(true);
    await life.purgeDeletedProject(p.id, { actor: { id: 'admin1', role: 'admin' } });
    expect(await exists(path.join(trash.trashRoot(), moved.trashDir))).toBe(false);
    expect(await exists(getProjectWorkspace(p.id))).toBe(false);
    expect(store.getProjectIncludingDeleted(p.id)).toBeNull();
    expect(showcase.listEntries('u_t').some((e) => e.projectId === p.id)).toBe(false);
    expect(db.prepare('SELECT id FROM runs WHERE project_id = ?').all(p.id).map((r) => r.id)).toEqual(['run_trash_keep1']);
    const [ev] = listDeletionEvents({ projectId: p.id });
    expect(ev).toMatchObject({ action: 'purge', reason: 'user', result: 'ok', actorId: 'admin1', actorIsAdmin: true });
    expect(ev.workspaceBytes).toBeGreaterThan(0);
    expect(ev.workspaceFiles).toBeGreaterThan(0);
  });

  it('挪不动留在原处的工作区：彻底删除时从原处删', async () => {
    const p = await liveProject('原处删');
    store.markProjectDeleted(p.id);   // 模拟挪目录失败：只有标记，没有 trash_dir
    await life.purgeDeletedProject(p.id);
    expect(await exists(getProjectWorkspace(p.id))).toBe(false);
  });
});

describe('到期清理', () => {
  it('⭐ 过了保留期的清掉、没过的留着；记 expired；无主的过期回收目录也清', async () => {
    const DAY = 86_400_000;
    const now = Date.parse('2026-10-01T00:00:00.000Z');
    const old = await liveProject('过期的');
    const fresh = await liveProject('没过期的');
    const oldMoved = await softDelete(old, new Date(now - 8 * DAY).toISOString());
    const freshMoved = await softDelete(fresh, new Date(now - 2 * DAY).toISOString());
    // 无主目录：库里没有对应删除记录
    const orphan = trash.trashEntryName('proj_orphan_dir1', new Date(now - 30 * DAY));
    await fs.mkdir(path.join(trash.trashRoot(), orphan, 'shared'), { recursive: true });
    const r = await life.sweepExpiredTrash({ now, days: 7, pauseMs: 0 });
    expect(r.purged).toContain(old.id);
    expect(r.purged).not.toContain(fresh.id);
    expect(r.orphans).toContain(orphan);
    expect(await exists(path.join(trash.trashRoot(), oldMoved.trashDir))).toBe(false);
    expect(await exists(path.join(trash.trashRoot(), freshMoved.trashDir))).toBe(true);
    expect(store.getProjectIncludingDeleted(old.id)).toBeNull();
    expect(store.getProjectIncludingDeleted(fresh.id)?.deletedAt).toBeTruthy();
    expect(listDeletionEvents({ projectId: old.id })[0]).toMatchObject({ action: 'purge', reason: 'expired', actorId: null });
  });

  it('清理出错只记日志、不抛；那一个留到下一轮', async () => {
    const DAY = 86_400_000;
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    const p = await liveProject('清不掉的');
    const moved = await softDelete(p, new Date(now - 9 * DAY).toISOString());
    store.setProjectTrashDir(p.id, 'bad/name');   // trashPathOf 会拒绝 → purge 抛
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await life.sweepExpiredTrash({ now, days: 7, pauseMs: 0 });
    warn.mockRestore();
    expect(r.failed).toContain(p.id);
    expect(store.getProjectIncludingDeleted(p.id)?.deletedAt).toBeTruthy();
    expect(listDeletionEvents({ projectId: p.id })[0]).toMatchObject({ action: 'purge', result: 'error' });
    // ⭐ 项目还在回收站里：它名下的目录不能被「无主目录」那条路顺手删掉
    expect(r.orphans).not.toContain(moved.trashDir);
    expect(await exists(path.join(trash.trashRoot(), moved.trashDir))).toBe(true);
  });

  it('startTrashSweeper 返回停止函数（计时器 unref，不拖住进程）', () => {
    const stop = life.startTrashSweeper({ initialDelayMs: 60_000, intervalMs: 60_000 });
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('文件夹项目（桌面版）', () => {
  it('⭐ 删进回收站后在同一路径再打开 = 恢复原项目，不撞唯一索引、不换 id', async () => {
    const folder = path.join(tmp, 'my-repo');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'README.md'), '# repo');
    const first = await openFolder({ path: folder, ownerId: '_anon' });
    await softDelete(first.project);
    expect(store.getProject(first.project.id)).toBeNull();
    // 用户的文件夹本身不动
    expect(await fs.readFile(path.join(folder, 'README.md'), 'utf8')).toBe('# repo');
    const again = await openFolder({ path: folder, ownerId: '_anon' });
    expect(again.project.id).toBe(first.project.id);
    expect(again.created).toBe(false);
    expect(store.getProject(first.project.id)?.folderPath).toBe(folder);
    expect(listDeletionEvents({ projectId: first.project.id })[0]).toMatchObject({ action: 'restore', reason: 'folder-reopen' });
  });
});
