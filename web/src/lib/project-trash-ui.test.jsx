// @vitest-environment happy-dom
/**
 * 项目回收站的前端一半（09-17，问题库 iss_mtjex6wv_5xhn）：
 * 删除确认框写保留期、toast「已删除 · 撤销」、首页「最近删除」能恢复与立即永久删除。
 * 真渲一遍、真点一下（编译过不算数）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const remove = vi.fn();
const list = vi.fn();
vi.mock('./api.js', async (orig) => {
  const real = await orig();
  return { ...real, Projects: { ...real.Projects, remove: (...a) => remove(...a), list: (...a) => list(...a) } };
});
const trashList = vi.fn();
const trashRestore = vi.fn();
const trashPurge = vi.fn();
vi.mock('./api-trash.js', () => ({
  Trash: { list: (...a) => trashList(...a), restore: (...a) => trashRestore(...a), purge: (...a) => trashPurge(...a) },
}));

const { useProjectDelete, deleteConfirmMessage } = await import('./use-project-delete.js');
const { useProjectStore } = await import('../stores/projectStore.js');
const { useGlobalStore } = await import('../stores/globalStore.js');
const { default: RecentlyDeletedModal, remainingDays } = await import('../components/project/RecentlyDeletedModal.jsx');

const P = (id, name, updatedAt) => ({ id, name, kind: 'project', updatedAt });
let host; let root; let confirm;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  confirm = vi.fn(async () => true);
  useGlobalStore.setState({ toasts: [], confirm });
  useProjectStore.setState({
    projects: [P('proj_a1b2c3', '甲', '2026-09-17 10:00:00'), P('proj_d4e5f6', '乙', '2026-09-16 10:00:00'), P('proj_g7h8i9', '丙', '2026-09-15 10:00:00')],
    trashDays: 7,
  });
  for (const f of [remove, list, trashList, trashRestore, trashPurge]) f.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** 把 hook 拿出来用：渲一个空组件，把返回的函数交出来 */
async function mountHook() {
  let fn;
  function Probe() { const f = useProjectDelete(); useEffect(() => { fn = f; }); return null; }
  await act(async () => { root.render(<Probe />); });
  return (...a) => fn(...a);
}
const toasts = () => useGlobalStore.getState().toasts;
const ids = () => useProjectStore.getState().projects.map((p) => p.id);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('删除项目：确认框 → 回收站 → 撤销', () => {
  it('⭐ 确认框写的是保留期（跟服务端的天数走），不再写「不可撤销」；取消就不删', async () => {
    useProjectStore.setState({ trashDays: 3 });
    const del = await mountHook();
    confirm.mockResolvedValueOnce(false);
    expect(await del(P('proj_d4e5f6', '乙'))).toBe(false);
    const { message, danger } = confirm.mock.calls[0][0];
    expect(message).toContain('最近删除');
    expect(message).toContain('3 天内可以恢复');
    expect(message).not.toContain('不可撤销');
    expect(danger).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteConfirmMessage('x', undefined)).toContain('7 天内');
  });

  it('⭐ 删除后 toast「已删除 · 撤销」；点撤销 → 恢复并按原来的顺序放回列表', async () => {
    remove.mockResolvedValue({ deleted: true, retentionDays: 7, warning: null });
    trashRestore.mockResolvedValue({ project: P('proj_d4e5f6', '乙', '2026-09-16 10:00:00') });
    const onDeleted = vi.fn();
    const del = await mountHook();
    expect(await del(P('proj_d4e5f6', '乙'), { onDeleted })).toBe(true);
    expect(remove).toHaveBeenCalledWith('proj_d4e5f6');
    expect(ids()).toEqual(['proj_a1b2c3', 'proj_g7h8i9']);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    const [tt] = toasts();
    expect(tt.msg).toBe('已删除「乙」');
    expect(tt.action.label).toBe('撤销');
    await act(async () => { await tt.action.onClick(); });
    expect(trashRestore).toHaveBeenCalledWith('proj_d4e5f6');
    expect(ids()).toEqual(['proj_a1b2c3', 'proj_d4e5f6', 'proj_g7h8i9']);
    expect(toasts().at(-1)).toMatchObject({ msg: '已恢复「乙」', kind: 'success' });
  });

  it('工作区文件被占用没挪走：删除照常成立，另给一条提示', async () => {
    remove.mockResolvedValue({ deleted: true, retentionDays: 7, warning: '项目已删除，但工作区文件正被占用，没能移进回收站；恢复不受影响。' });
    const del = await mountHook();
    await del(P('proj_a1b2c3', '甲'));
    expect(toasts().map((x) => x.kind)).toEqual(['info', 'error']);
    expect(toasts()[1].msg).toMatch(/被占用/);
  });

  it('删除失败：报错、不调 onDeleted、列表不动', async () => {
    remove.mockRejectedValue(new Error('网络断了'));
    const onDeleted = vi.fn();
    const del = await mountHook();
    expect(await del(P('proj_a1b2c3', '甲'), { onDeleted })).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(3);
    expect(toasts()[0]).toMatchObject({ kind: 'error', msg: '删除失败：网络断了' });
  });

  it('列表接口带回保留天数，store 记下', async () => {
    list.mockResolvedValue({ projects: [], trashRetentionDays: 14 });
    useProjectStore.setState({ hydrating: false });
    await useProjectStore.getState().hydrate({ kind: 'project' });
    expect(useProjectStore.getState().trashDays).toBe(14);
  });
});

describe('首页「最近删除」', () => {
  const now = Date.now();
  const ROWS = [
    { id: 'proj_x1y2z3', name: '旧海报', deletedAt: new Date(now - 2 * 86_400_000).toISOString(), purgeAfter: new Date(now + 5 * 86_400_000 - 1000).toISOString(), publishedSites: 1 },
    { id: 'proj_q1w2e3', name: '草稿站', deletedAt: new Date(now - 60_000).toISOString(), purgeAfter: new Date(now + 7 * 86_400_000).toISOString(), publishedSites: 0 },
  ];
  const renderModal = async () => { await act(async () => { root.render(<RecentlyDeletedModal show onClose={() => {}} />); }); await flush(); };
  const rows = () => [...document.querySelectorAll('[data-testid="trash-row"]')];
  const btn = (row, label) => [...row.querySelectorAll('button')].find((b) => b.textContent.includes(label));

  it('⭐ 列出保留期、每项剩几天、仍在线的已发布站点', async () => {
    trashList.mockResolvedValue({ retentionDays: 7, projects: ROWS });
    await renderModal();
    const text = document.body.textContent;
    expect(text).toContain('删除的项目在这里保留 7 天');
    expect(rows().map((r) => r.textContent.includes('旧海报') || r.textContent.includes('草稿站'))).toEqual([true, true]);
    expect(rows()[0].textContent).toContain('5 天后永久删除');
    expect(rows()[0].textContent).toContain('1 个已发布的站点仍在线');
    expect(rows()[1].textContent).not.toContain('已发布的站点');
  });

  it('⭐ 恢复：调恢复接口，这一行消失，项目回到首页列表', async () => {
    trashList.mockResolvedValue({ retentionDays: 7, projects: ROWS });
    trashRestore.mockResolvedValue({ project: P('proj_q1w2e3', '草稿站', '2026-09-17 12:00:00') });
    await renderModal();
    await act(async () => { btn(rows()[1], '恢复').click(); });
    await flush();
    expect(trashRestore).toHaveBeenCalledWith('proj_q1w2e3');
    expect(rows()).toHaveLength(1);
    expect(ids()[0]).toBe('proj_q1w2e3');
    expect(toasts().at(-1).msg).toBe('已恢复「草稿站」');
  });

  it('⭐ 立即永久删除：先二次确认（写明无法恢复），确认后才调接口；取消不动', async () => {
    trashList.mockResolvedValue({ retentionDays: 7, projects: ROWS });
    trashPurge.mockResolvedValue({ purged: true });
    await renderModal();
    confirm.mockResolvedValueOnce(false);
    await act(async () => { btn(rows()[0], '永久删除').click(); });
    await flush();
    expect(trashPurge).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0][0].message).toContain('无法恢复');
    await act(async () => { btn(rows()[0], '永久删除').click(); });
    await flush();
    expect(trashPurge).toHaveBeenCalledWith('proj_x1y2z3');
    expect(rows()).toHaveLength(1);
  });

  it('空的时候说没有', async () => {
    trashList.mockResolvedValue({ retentionDays: 7, projects: [] });
    await renderModal();
    expect(document.body.textContent).toContain('最近没有删除的项目。');
  });

  it('remainingDays：向上取整、过期记 0、非法为 null', () => {
    const t0 = Date.parse('2026-09-17T00:00:00Z');
    expect(remainingDays('2026-09-20T00:00:00Z', t0)).toBe(3);
    expect(remainingDays('2026-09-17T01:00:00Z', t0)).toBe(1);
    expect(remainingDays('2026-09-16T00:00:00Z', t0)).toBe(0);
    expect(remainingDays(null, t0)).toBeNull();
  });
});

describe('入口接线（源码判据）', () => {
  const read = (rel) => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
  it('⭐ 首页与工作台都走同一个删除交互，项目删除不再写「此操作不可撤销」；首页有「最近删除」入口', () => {
    for (const f of ['routes/Home.jsx', 'routes/ProjectWorkspace.jsx']) {
      const src = read(f);
      expect(src, f).toMatch(/useProjectDelete\(\)/);
      expect(src, f).not.toMatch(/删除「[^」]*」？此操作不可撤销/);
    }
    const home = read('routes/Home.jsx');
    expect(home).toMatch(/<RecentlyDeletedModal\b/);
    expect(home).toMatch(/setTrashOpen\(true\)/);
  });
});
