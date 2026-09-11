import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（跟其它服务端测试同一套纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-tasklist-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { EventBus } = await import('../agent/events.js');
const { attachBoardTasklist, canvasIdForRel, _resetBoardTasklist } = await import('./board-tasklist.js');
const { readBoard, patchBoard } = await import('../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../projects/workspace.js');

const pid = 'proj_tasklist_test';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// 事件是异步落盘的：等到断言成立为止，别拿固定毫秒数赌（09-11 Windows runner 上 300ms 不够，红过）。
// 只有「什么都不该发生」的那种检查还用固定等待 —— 轮询证明不了没发生。
const SETTLE = { timeout: 5000, interval: 50 };

describe('board-tasklist（步骤清单镜像成板书）', () => {
  beforeAll(async () => { await ensureProjectWorkspace(pid); _resetBoardTasklist(); });

  it('canvasIdForRel：精确 > deck: > 站点根 > 原样', () => {
    const board = { objects: { 'deck:a.html': { x: 0, y: 0 }, 'site:Duvet': { x: 0, y: 0 }, 'assets/x.png': { x: 0, y: 0 } } };
    expect(canvasIdForRel(board, 'assets/x.png')).toBe('assets/x.png');
    expect(canvasIdForRel(board, 'a.html')).toBe('deck:a.html');
    expect(canvasIdForRel(board, 'Duvet/style.css')).toBe('site:Duvet');
    expect(canvasIdForRel(board, 'new.html')).toBe('deck:new.html');
  });

  it('todo → 板书文件 + 座位；file_changed → 到产物的「第 N 步」线；done 清状态', async () => {
    const bus = new EventBus();
    attachBoardTasklist(bus, pid);
    await patchBoard(pid, { objects: { 'deck:海报.html': { x: 100, y: 100 } } });
    const runId = 'run_abcdef123456';
    bus.publish({ type: 'run.todo.updated', runId, sessionId: 's1', todos: [
      { content: '定风格', status: 'completed', activeForm: '定风格' },
      { content: '画海报', status: 'in_progress', activeForm: '画海报' },
      { content: '写说明', status: 'pending', activeForm: '写说明' },
    ] });
    let board; let chalkIds; let raw;
    await vi.waitFor(async () => {
      board = await readBoard(pid);
      chalkIds = Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'));
      expect(chalkIds.length).toBe(1);
      raw = await fs.readFile(path.join(getSharedDir(pid), chalkIds[0]), 'utf8');
      expect(raw).toContain('- [ ] 写说明');
    }, SETTLE);
    expect(raw).toContain('nd: chalk');
    expect(raw).toContain('- [x] 定风格');
    expect(raw).toContain('**→ 画海报**');
    expect(raw).toContain('- [ ] 写说明');

    bus.publish({ type: 'run.file_changed', runId, sessionId: 's1', filePath: '海报.html', event: 'change' });
    bus.publish({ type: 'run.file_changed', runId, sessionId: 's1', filePath: '海报.html', event: 'change' });   // 同一件只连一次
    let lines;
    await vi.waitFor(async () => {
      board = await readBoard(pid);
      lines = Object.values(board.bindings).filter(b => b.from === chalkIds[0]);
      expect(lines.length).toBe(1);
    }, SETTLE);
    await wait(200);   // 第二条同件事件也处理完，确认没多连一条
    board = await readBoard(pid);
    lines = Object.values(board.bindings).filter(b => b.from === chalkIds[0]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ to: 'deck:海报.html', type: 'annotates', by: 'auto', label: '第 2 步' });

    // 更新清单：原地改，座位不动、文件同一个
    const pos = board.objects[chalkIds[0]];
    bus.publish({ type: 'run.todo.updated', runId, sessionId: 's1', todos: [
      { content: '定风格', status: 'completed' }, { content: '画海报', status: 'completed' }, { content: '写说明', status: 'in_progress', activeForm: '正在写说明' },
    ] });
    await vi.waitFor(async () => {
      expect(await fs.readFile(path.join(getSharedDir(pid), chalkIds[0]), 'utf8')).toContain('**→ 正在写说明**');
    }, SETTLE);
    board = await readBoard(pid);
    expect(Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'))).toEqual(chalkIds);
    expect(board.objects[chalkIds[0]].x).toBe(pos.x);

    bus.publish({ type: 'run.done', runId, sessionId: 's1' });
    // 工完线收（2026-08-30）：这一轮的 auto 步骤线随 run 结束拆掉，便签留着
    await vi.waitFor(async () => {
      board = await readBoard(pid);
      expect(Object.values(board.bindings).filter(b => b.from === chalkIds[0]).length).toBe(0);
    }, SETTLE);
    bus.publish({ type: 'run.file_changed', runId, sessionId: 's1', filePath: 'b.png', event: 'change' });
    await wait(200);
    board = await readBoard(pid);
    expect(Object.values(board.bindings).filter(b => b.from === chalkIds[0]).length).toBe(0);

    // 项目单例（2026-08-30）：第二轮不再新建便签，同一张原地重写；位置跨轮保留
    const seatBefore = board.objects[chalkIds[0]];
    bus.publish({ type: 'run.todo.updated', runId: 'run_zzz999888777', sessionId: 's2', todos: [
      { content: '铺开档案站', status: 'in_progress', activeForm: '铺开档案站' },
    ] });
    await vi.waitFor(async () => {
      expect(await fs.readFile(path.join(getSharedDir(pid), chalkIds[0]), 'utf8')).toContain('**→ 铺开档案站**');
    }, SETTLE);
    board = await readBoard(pid);
    expect(Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'))).toEqual(chalkIds);
    expect(board.objects[chalkIds[0]].x).toBe(seatBefore.x);
  });

  it('重启后按 tag 认领旧便签，不再新建（proj_mtfz7n8p 的重复病）', async () => {
    _resetBoardTasklist();   // 模拟服务端重启：内存台账全丢
    const bus = new EventBus();
    attachBoardTasklist(bus, pid);
    bus.publish({ type: 'run.todo.updated', runId: 'run_reboot000001', sessionId: 's3', todos: [
      { content: '接着干', status: 'in_progress', activeForm: '接着干' },
    ] });
    await vi.waitFor(async () => {
      const board = await readBoard(pid);
      const chalkIds = Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'));
      expect(chalkIds.length).toBe(1);
      expect(await fs.readFile(path.join(getSharedDir(pid), chalkIds[0]), 'utf8')).toContain('**→ 接着干**');
    }, SETTLE);
  });
});
