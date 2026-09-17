import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 隔离数据目录（09-17 起这里会真的读写板：pruneGhostSeats）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-audit-data-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { auditWorkspace, attachWorkspaceAudit, pruneGhostSeats, ghostSeats } = await import('./workspace-audit.js');
const { EventBus } = await import('../engine/agent/events.js');
const { readBoard, patchBoard, _noteRenamesForTest, _resetRenameJournal } = await import('../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../projects/workspace.js');

describe('工作区对账', () => {
  it('板上有磁盘没有 → dangling；磁盘有板上没有 → unseated；目录卡整段认领；原生物件与保留目录跳过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-audit-'));
    fs.writeFileSync(path.join(root, '封面.png'), 'x');
    fs.mkdirSync(path.join(root, '官网'), { recursive: true }); fs.writeFileSync(path.join(root, '官网', 'index.html'), 'x'); fs.writeFileSync(path.join(root, '官网', 'a.css'), 'x');
    fs.writeFileSync(path.join(root, '孤儿.md'), 'x');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true }); fs.writeFileSync(path.join(root, 'assets', 'ref.jpg'), 'x');
    const board = { objects: { '封面.png': { x: 1 }, 'site:官网': { x: 2 }, 'deck:没了.html': { x: 3 }, 'C:': { x: 4 }, 'scribble:abc': { x: 5 } } };
    const r = await auditWorkspace('p', { sharedRoot: root, board });
    expect(r.dangling.sort()).toEqual(['C:', 'deck:没了.html']);
    expect(r.unseated).toEqual(['孤儿.md']);
    expect(r.checked).toBe(4);
  });
  it('挂在 bus 上：run.done 后对账，有 dangling 才记问题', async () => {
    const bus = new EventBus(); const issues = [];
    let result = { dangling: [] };
    attachWorkspaceAudit(bus, 'p', { audit: async () => result, record: (i) => issues.push(i), prune: async () => ({ pruned: [], suspects: [] }), delayMs: 5 });
    bus.publish({ type: 'run.done', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 30));
    expect(issues).toHaveLength(0);
    result = { dangling: ['deck:没了.html'] };
    bus.publish({ type: 'run.done', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 30));
    expect(issues).toHaveLength(1);
    expect(issues[0].signature).toBe('workspace-audit|p');
  });
});

/**
 * 09-17 幽灵座位自动清理（iss_mu3kqljp_6ycd / iss_mu0mx6q6_jx75 / iss_mtyisspu_ds3r / iss_mtx1v74x_9p5v / iss_mtg7ls2w_w80i）：
 * 口径照 assets.js confirmDeadZones —— 连着两次都不在、不在改名窗口里才剪；板书与画布原生件不在范围内。
 */
describe('幽灵座位清理（09-17）', () => {
  const noReconcile = async () => ({ renamed: 0 });
  let pid; let root;
  const put = async (rel) => { await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fsp.writeFile(path.join(root, rel), 'x'); };
  beforeAll(async () => {
    pid = 'proj_audit_prune';
    await ensureProjectWorkspace(pid);
    root = getSharedDir(pid);
    await put('在的.png');
    await put('在的站/index.html');
    await put('剧本/stage/场记.md');
    await patchBoard(pid, {
      objects: {
        '在的.png': { x: 0, y: 0 }, '删掉的.png': { x: 300, y: 0 }, 'site:在的站': { x: 600, y: 0 }, 'site:没了的站': { x: 900, y: 0 },
        'notes/板书/无文件.md': { x: 0, y: 300, by: 'agent' }, 'text:a1': { x: 300, y: 300, kind: 'text', data: { t: '手写' } },
        'stage:剧本/stage': { x: 600, y: 300 }, browse: { x: 900, y: 300 },
      },
      bindings: { 'b:1': { type: 'link', from: '删掉的.png', to: '在的.png' }, 'b:2': { type: 'link', from: 'site:在的站', to: '在的.png' } },
    });
  });

  it('⭐ 只认文件已删的产物 / 文件卡：板书、手写字、演出卡、浏览器卡不算', async () => {
    const b = await readBoard(pid);
    expect(ghostSeats(b, root).sort()).toEqual(['site:没了的站', '删掉的.png'].sort());
  });

  it('⭐ 第一次只记嫌疑不剪；第二次才剪，连着它的线一起清，其余不动', async () => {
    const first = await pruneGhostSeats(pid, { reconcile: noReconcile });
    expect(first.pruned).toEqual([]);
    expect(first.suspects.sort()).toEqual(['site:没了的站', '删掉的.png'].sort());
    expect((await readBoard(pid)).objects['删掉的.png']).toBeTruthy();
    const second = await pruneGhostSeats(pid, { reconcile: noReconcile });
    expect(second.pruned.sort()).toEqual(['site:没了的站', '删掉的.png'].sort());
    const b = await readBoard(pid);
    expect(b.objects['删掉的.png']).toBeUndefined();
    expect(b.objects['site:没了的站']).toBeUndefined();
    expect(b.bindings['b:1']).toBeUndefined();   // 端点级联（patchBoard 的 removed）
    expect(b.bindings['b:2']).toBeTruthy();
    for (const id of ['在的.png', 'site:在的站', 'notes/板书/无文件.md', 'text:a1', 'stage:剧本/stage', 'browse']) expect(b.objects[id], id).toBeTruthy();
  });

  it('⭐ 改名窗口里的不碰；两次之间文件回来了不剪', async () => {
    _resetRenameJournal();
    await patchBoard(pid, { objects: { '旧名.png': { x: 0, y: 900 }, '会回来的.png': { x: 300, y: 900 } } });
    _noteRenamesForTest(pid, [['旧名.png', '新名.png']]);
    await pruneGhostSeats(pid, { reconcile: noReconcile });
    await put('会回来的.png');
    const r = await pruneGhostSeats(pid, { reconcile: noReconcile });
    expect(r.pruned).toEqual([]);
    const b = await readBoard(pid);
    expect(b.objects['会回来的.png']).toBeTruthy();
    expect(b.objects['旧名.png']).toBeTruthy();   // 转发表说它刚改了名：不当删除处理
    _resetRenameJournal();
  });

  it('挂在 bus 上：会被自动剪的不记问题；第一次留下嫌疑就在 confirmMs 后再判一次（不等下个回合）', async () => {
    const bus = new EventBus(); const issues = []; const calls = [];
    const prune = async () => { calls.push(Date.now()); return calls.length === 1 ? { pruned: [], suspects: ['删掉的.png'] } : { pruned: ['删掉的.png'], suspects: [] }; };
    const audit = async () => ({ dangling: ['删掉的.png', 'C:'], ghostSeats: ['删掉的.png'] });
    attachWorkspaceAudit(bus, 'p2', { audit, record: (i) => issues.push(i), prune, delayMs: 5, confirmMs: 20 });
    bus.publish({ type: 'run.done', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toBe('C:');
  });
});
