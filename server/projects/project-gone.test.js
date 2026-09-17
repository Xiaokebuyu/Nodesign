/**
 * 3b（09-17，问题库 iss_mtjex6wv_5xhn）：已删除的项目不许重建工作区、不许写画布。
 *
 * 事故形状：删除后仍在飞的回合调 write_on_board → writeBoard → ensureProjectWorkspace，
 * 把工作区整套建回来（带 init 提交）。这里每条都先把项目删进回收站，再走那几条写入口，
 * 判「抛 PROJECT_GONE 且磁盘上没有长出目录」。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-gone-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const store = await import('./store.js');
const { ensureProjectWorkspace, ensureSessionWorkspace, getProjectWorkspace, getSharedDir, PROJECTS_DATA_ROOT } = await import('./workspace.js');
const { patchBoard, readBoard, pinToZone } = await import('./board-store.js');
const { writeChalkFile } = await import('../lib/chalk.js');
const { PROJECT_GONE, isProjectGone, projectIdOfPath } = await import('./project-gone.js');
const { moveWorkspaceToTrash } = await import('./project-trash.js');
const { tierDenial } = await import('../engine/mcp/tools/tier-gate.js');
const { startProcess } = await import('../engine/process/registry.js');
const { recordDeletionEvent } = await import('./deletion-log.js');
const { getProjectBus, disposeProjectBus } = await import('../ws/broker.js');
const active = await import('../engine/runs/active-runs.js');
const { AsyncQueue } = await import('../lib/async-queue.js');

const exists = async (p) => { try { await fs.lstat(p); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一个活项目并备好工作区，再删进回收站（标记 + 挪目录 + 占位文件） */
async function trashedProject(name) {
  const p = store.createProject({ name, ownerId: 'u_gone' });
  await ensureProjectWorkspace(p.id);
  store.markProjectDeleted(p.id);
  const moved = await moveWorkspaceToTrash(p.id);
  store.setProjectTrashDir(p.id, moved.trashDir);
  return p;
}

afterEach(() => { process.env.NODESIGN_ROWLESS_PROJECTS = 'allow'; });

describe('存在性闸：已删除的项目', () => {
  let p;
  beforeAll(async () => { p = await trashedProject('已删项目'); });

  it('⭐ ensureProjectWorkspace 抛 PROJECT_GONE，原路径不会长回目录', async () => {
    await expect(ensureProjectWorkspace(p.id)).rejects.toMatchObject({ code: PROJECT_GONE, status: 410 });
    const st = await fs.lstat(getProjectWorkspace(p.id));
    expect(st.isDirectory()).toBe(false);   // 还是那个占位文件
    expect(await exists(getSharedDir(p.id))).toBe(false);
  });

  it('⭐ 写画布（patchBoard / pinToZone）抛 PROJECT_GONE，报错文案叫 agent 停手', async () => {
    const err = await patchBoard(p.id, { objects: { 'a.md': { x: 1, y: 2 } } }).catch((e) => e);
    expect(err.code).toBe(PROJECT_GONE);
    expect(err.message).toMatch(/项目已被删除/);
    expect(err.message).toMatch(/停止/);
    await expect(pinToZone(p.id, { objectId: 'b.md' })).rejects.toMatchObject({ code: PROJECT_GONE });
    expect(await exists(path.join(getSharedDir(p.id), 'board.json'))).toBe(false);
  });

  it('⭐ ensureSessionWorkspace（turn / canvas 路由的入口）同样拒绝', async () => {
    await expect(ensureSessionWorkspace(p.id, '11111111-2222-3333-4444-555555555555')).rejects.toMatchObject({ code: PROJECT_GONE });
  });

  it('⭐ write_on_board 先写的板书文件：writeChalkFile 按路径认出项目并拒绝', async () => {
    await expect(writeChalkFile(getSharedDir(p.id), 'x.md', 'hi')).rejects.toMatchObject({ code: PROJECT_GONE });
    expect(await exists(path.join(getSharedDir(p.id), 'notes'))).toBe(false);
  });

  it('生图等档位闸工具：报「项目已删除」而不是「档位不包含生图」', () => {
    const r = tierDenial(p.id, 'imageGen', 'generate_image');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/项目已被删除/);
  });

  it('后台进程不许再起', async () => {
    await expect(startProcess({ projectId: p.id, command: 'echo hi' })).rejects.toMatchObject({ code: PROJECT_GONE });
  });

  it('⭐ 占位文件兜住没经过闸的 mkdir -p（SDK 自己的 .claude/.cc-writes 就是这条路）', async () => {
    const err = await fs.mkdir(path.join(getSharedDir(p.id), '.claude', '.cc-writes'), { recursive: true }).catch((e) => e);
    expect(err?.code).toBe('ENOTDIR');
  });

  it('活项目照常：ensure 与写画布都通', async () => {
    const live = store.createProject({ name: '活项目', ownerId: 'u_gone' });
    await ensureProjectWorkspace(live.id);
    await patchBoard(live.id, { objects: { 'a.md': { x: 1, y: 2 } } });
    expect((await readBoard(live.id)).objects['a.md']).toBeTruthy();
    expect(isProjectGone(live.id)).toBe(false);
  });
});

describe('没有项目行的 pid', () => {
  it('⭐ 生产口径（不设放行变量）：无行 = 已删除，ensure 拒绝、不建目录', async () => {
    delete process.env.NODESIGN_ROWLESS_PROJECTS;
    const pid = 'proj_norow_strict1';
    await expect(ensureProjectWorkspace(pid)).rejects.toMatchObject({ code: PROJECT_GONE });
    expect(await exists(path.join(PROJECTS_DATA_ROOT, pid))).toBe(false);
  });

  it('测试放行口径：无行放行，但审计账里记过被删的照拦（彻底删除之后的迟到写入）', async () => {
    process.env.NODESIGN_ROWLESS_PROJECTS = 'allow';
    expect(isProjectGone('proj_norow_allow1')).toBe(false);
    recordDeletionEvent({ action: 'purge', projectId: 'proj_norow_purged', result: 'ok' });
    expect(isProjectGone('proj_norow_purged')).toBe(true);
    await expect(ensureProjectWorkspace('proj_norow_purged')).rejects.toMatchObject({ code: PROJECT_GONE });
  });

  it('projectIdOfPath：只认数据根下第一段；数据根外（文件夹项目）不认', () => {
    expect(projectIdOfPath(path.join(PROJECTS_DATA_ROOT, 'proj_abcdef_x1', 'shared', 'notes'))).toBe('proj_abcdef_x1');
    expect(projectIdOfPath(path.join(PROJECTS_DATA_ROOT, '.trash', 'proj_abcdef_x1-1'))).toBeNull();
    expect(projectIdOfPath(path.join(os.tmpdir(), 'somewhere', 'proj_abcdef_x1'))).toBeNull();
  });
});

describe('默认查询把回收站里的项目当不存在', () => {
  it('getProject / listProjects / countProjects / folderPathOf / getProjectByFolder', async () => {
    const folder = path.join(tmp, 'user-folder');
    const p = store.createProject({ name: '文件夹项目', ownerId: 'u_list', folderPath: folder });
    expect(store.getProject(p.id)).toBeTruthy();
    expect(store.listProjects({ owner: 'u_list' }).map((x) => x.id)).toContain(p.id);
    store.markProjectDeleted(p.id);
    expect(store.getProject(p.id)).toBeNull();
    expect(store.listProjects({ owner: 'u_list' }).map((x) => x.id)).not.toContain(p.id);
    expect(store.countProjects({ owner: 'u_list' })).toBe(0);
    expect(store.folderPathOf(p.id)).toBeNull();
    expect(store.getProjectByFolder(folder)).toBeNull();
    // 回收站那一组读得到
    expect(store.getProjectIncludingDeleted(p.id).deletedAt).toBeTruthy();
    expect(store.getDeletedProjectByFolder(folder)?.id).toBe(p.id);
    expect(store.listDeletedProjects({ owner: 'u_list' }).map((x) => x.id)).toEqual([p.id]);
    expect(store.projectRowState(p.id)).toBe('deleted');
    store.clearProjectDeleted(p.id);
    expect(store.getProject(p.id)?.folderPath).toBe(folder);
  });
});

describe('项目总线：删除时停掉入座器与对账的计时器', () => {
  it('⭐ disposeProjectBus 之后，攒着的 file_changed 批次不再落板', async () => {
    const p = store.createProject({ name: '总线项目', ownerId: 'u_bus' });
    await ensureProjectWorkspace(p.id);
    const root = getSharedDir(p.id);
    await fs.writeFile(path.join(root, '新产物.md'), 'hi', 'utf8');
    const bus = getProjectBus(p.id);
    bus.publish({ type: 'run.file_changed', runId: 'run_bus0001', filePath: '新产物.md', event: 'change' });
    disposeProjectBus(p.id);
    bus.publish({ type: 'run.done', runId: 'run_bus0001' });
    await wait(1800);   // 入座器的攒批窗口是 1.5s
    expect((await readBoard(p.id)).objects['新产物.md']).toBeUndefined();
  });

  it('对照：不 dispose 时同一批会入座（证明上一条的判据有效）', async () => {
    const p = store.createProject({ name: '总线对照', ownerId: 'u_bus' });
    await ensureProjectWorkspace(p.id);
    await fs.writeFile(path.join(getSharedDir(p.id), '新产物.md'), 'hi', 'utf8');
    const bus = getProjectBus(p.id);
    bus.publish({ type: 'run.file_changed', runId: 'run_bus0002', filePath: '新产物.md', event: 'change' });
    bus.publish({ type: 'run.done', runId: 'run_bus0002' });
    await wait(300);
    expect((await readBoard(p.id)).objects['新产物.md']).toBeTruthy();
    disposeProjectBus(p.id);
  });
});

describe('等会话真正退出', () => {
  const SID = '99999999-2222-3333-4444-555555555555';
  const SID2 = '99999999-2222-3333-4444-666666666666';

  it('⭐ closeQuerySession 不算退出；runSession 收尾（带 token 注销）才放行等待者', async () => {
    const token = active.registerQuerySession(SID, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: 'proj_wait_a1' });
    expect(active.listQuerySessionIdsForProject('proj_wait_a1')).toEqual([SID]);
    active.closeQuerySession(SID, 'project_deleted');
    expect(active.listQuerySessionIdsForProject('proj_wait_a1')).toEqual([]);
    let exited = false;
    setTimeout(() => { exited = true; active.unregisterQuerySession(SID, token); }, 150);
    const r = await active.waitForProjectSessionsExit('proj_wait_a1', 5000);
    expect(exited).toBe(true);
    expect(r).toEqual({ waited: 1, pending: 0 });
  });

  it('收尾不来就等到超时，报 pending', async () => {
    active.registerQuerySession(SID2, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: 'proj_wait_b1' });
    active.closeQuerySession(SID2, 'project_deleted');
    const t0 = Date.now();
    const r = await active.waitForProjectSessionsExit('proj_wait_b1', 120);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(r).toEqual({ waited: 1, pending: 1 });
  });

  it('同 sid 关了马上重开：旧收尾不会放走新会话的等待者', async () => {
    const SID3 = '99999999-2222-3333-4444-777777777777';
    const oldTok = active.registerQuerySession(SID3, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: 'proj_wait_c1' });
    active.closeQuerySession(SID3);
    const newTok = active.registerQuerySession(SID3, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: 'proj_wait_c1' });
    active.unregisterQuerySession(SID3, oldTok);
    const r = await active.waitForProjectSessionsExit('proj_wait_c1', 50);
    expect(r).toEqual({ waited: 1, pending: 1 });
    active.unregisterQuerySession(SID3, newTok);
    expect(await active.waitForProjectSessionsExit('proj_wait_c1', 50)).toEqual({ waited: 0, pending: 0 });
  });
});
