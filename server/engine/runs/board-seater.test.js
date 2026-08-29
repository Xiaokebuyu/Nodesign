import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-seater-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { EventBus } = await import('../agent/events.js');
const { attachBoardSeater, seatArtifacts, seatable } = await import('./board-seater.js');
const { readBoard, patchBoard } = await import('../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../projects/workspace.js');
const { renderChalk } = await import('../../lib/chalk.js');

const pid = 'proj_seater_test';
let root;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  root = getSharedDir(pid);
});

describe('board-seater（入座下沉服务端）', () => {
  it('seatable：保留文件/隐藏段/构建垃圾不入座', () => {
    expect(seatable('小说/第一章.md')).toBe(true);
    expect(seatable('assets/generated/x.webp')).toBe(true);
    expect(seatable('ui-config.json')).toBe(false);
    expect(seatable('board.json')).toBe(false);
    expect(seatable('.nd/board-sync.json')).toBe(false);
    expect(seatable('site/node_modules/a.js')).toBe(false);
    expect(seatable('_drafts/x.html')).toBe(false);
    expect(seatable('/etc/passwd')).toBe(false);
    expect(seatable('a/../b.md')).toBe(false);
  });

  it('agent 写盘的文件回合末入座（26 秒没座位的病）', async () => {
    await fs.mkdir(path.join(root, '小说'), { recursive: true });
    await fs.writeFile(path.join(root, '小说/第一章.md'), '# 第一章', 'utf8');
    const { seated } = await seatArtifacts(pid, ['小说/第一章.md']);
    expect(seated).toBe(1);
    const board = await readBoard(pid);
    const e = board.objects['小说/第一章.md'];
    expect(e).toBeTruthy();
    expect(e.seat).toBe('auto');
    expect(Number.isFinite(e.x)).toBe(true);
  });

  it('幂等：已有座位不动', async () => {
    const before = (await readBoard(pid)).objects['小说/第一章.md'];
    const { seated } = await seatArtifacts(pid, ['小说/第一章.md']);
    expect(seated).toBe(0);
    const after = (await readBoard(pid)).objects['小说/第一章.md'];
    expect(after.x).toBe(before.x);
  });

  it('板书领养：Write 落盘的 chalk 按 frontmatter 接线上墙（10-05 friction）', async () => {
    // 先有一条已上墙的父板书
    await patchBoard(pid, { objects: { 'notes/板书/parent.md': { x: 100, y: 100, w: 300, h: 80, by: 'agent' } } });
    await fs.mkdir(path.join(root, 'notes/板书'), { recursive: true });
    await fs.writeFile(path.join(root, 'notes/板书/parent.md'), renderChalk({ body: '父', by: 'agent' }), 'utf8');
    const content = renderChalk({ body: '第十六章：东口', by: 'agent', replyTo: 'notes/板书/parent.md', tag: '章节' });
    await fs.writeFile(path.join(root, 'notes/板书/20260825-1200-第十六章.md'), content, 'utf8');
    const { seated, lines } = await seatArtifacts(pid, ['notes/板书/20260825-1200-第十六章.md']);
    expect(seated).toBe(1);
    expect(lines).toBe(1);
    const board = await readBoard(pid);
    const e = board.objects['notes/板书/20260825-1200-第十六章.md'];
    expect(e.tag).toBe('章节');
    expect(e.y).toBeGreaterThan(100);   // 落在父板书下方（线程）
    const flow = Object.values(board.bindings).find(b => b.type === 'flow' && b.from === 'notes/板书/parent.md');
    expect(flow).toBeTruthy();
  });

  it('事件已发但文件已删：跳过不复活', async () => {
    const { seated } = await seatArtifacts(pid, ['小说/被删了.md']);
    expect(seated).toBe(0);
  });

  it('挂 bus：file_changed 攒一轮，run.done 一批入座并广播', async () => {
    const bus = new EventBus();
    attachBoardSeater(bus, pid);
    const events = [];
    bus.subscribe('*', (e) => { if (e.type === 'board.updated') events.push(e); });
    await fs.writeFile(path.join(root, '新产物.md'), 'hi', 'utf8');
    const runId = 'run_seater0001';
    bus.publish({ type: 'run.file_changed', runId, filePath: '新产物.md', event: 'change' });
    bus.publish({ type: 'run.file_changed', runId, filePath: 'ui-config.json', event: 'change' });  // 不入座
    bus.publish({ type: 'run.done', runId });
    await wait(250);
    const board = await readBoard(pid);
    expect(board.objects['新产物.md']).toBeTruthy();
    expect(board.objects['ui-config.json']).toBeUndefined();
    expect(events.some(e => /入了座/.test(e.summary))).toBe(true);
  });
});
