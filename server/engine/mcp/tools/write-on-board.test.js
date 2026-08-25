import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-writeboard-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeWriteOnBoardTool, makeSketchOnBoardAlias } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');

const pid = 'proj_writeboard_test';
let sharedRoot;
let call;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
  const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx: { emit: () => {} } });
  call = (args) => t.handler(args);
});

describe('write_on_board 统一入口（件数判据）', () => {
  it('件数=1：{text} 落成 notes/板书 文件，不打 tag，不 staging', async () => {
    const r = await call({ text: '第一条板书' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const ids = Object.keys(board.objects).filter(id => id.startsWith('notes/板书/'));
    expect(ids.length).toBe(1);
    const e = board.objects[ids[0]];
    expect(e.tag).toBeUndefined();
    expect(e.staging).toBeUndefined();
    expect(e.seat).toBe('agent');
    const raw = await fs.readFile(path.join(sharedRoot, ids[0]), 'utf8');
    expect(raw).toContain('nd: chalk');
    expect(r.content[0].text).toMatch(/Visible in the user's viewport/);
  });

  it('near + relation:flow：线方向是 锚→板书（读序），不再只有批注', async () => {
    await patchBoard(pid, { objects: { 'assets/证物.png': { x: 1000, y: 1000, w: 200, h: 176 } } });
    const r = await call({ text: '接着上一章', near: 'assets/证物.png', relation: 'flow' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const flow = Object.values(board.bindings).find(b => b.type === 'flow' && b.from === 'assets/证物.png');
    expect(flow).toBeTruthy();
    expect(flow.to.startsWith('notes/板书/')).toBe(true);
  });

  it('side:left：板书落在锚点左侧（08-24 信箱「没有左边」案）', async () => {
    await patchBoard(pid, { objects: { 'assets/嫌疑人.png': { x: 3000, y: 3000, w: 200, h: 176 } } });
    const r = await call({ text: '讯问记录：不在场证明存疑', near: 'assets/嫌疑人.png', side: 'left' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const id = Object.keys(board.objects).filter(i => i.startsWith('notes/板书/')).sort().pop();
    const e = board.objects[id];
    expect(e.x + e.w).toBeLessThanOrEqual(3000);
    expect(r.content[0].text).toContain('left of the anchor');
  });

  it('chain:true：自动接在同 tag 最新板书下面（章节线程免抄路径）', async () => {
    const a = await call({ text: '第一章：出发', tag: '章节' });
    expect(a.isError).toBeUndefined();
    const b = await call({ text: '第二章：迷雾', tag: '章节', chain: true });
    expect(b.isError).toBeUndefined();
    const board = await readBoard(pid);
    const chapters = Object.entries(board.objects).filter(([, e]) => e.tag === '章节').map(([id]) => id).sort();
    const flow = Object.values(board.bindings).find(x => x.type === 'flow' && x.from === chapters[0] && x.to === chapters[1]);
    expect(flow).toBeTruthy();
    // 竖直线程：第二章在第一章下方
    expect(board.objects[chapters[1]].y).toBeGreaterThan(board.objects[chapters[0]].y);
  });

  it('件数≥2：画布原生 + 自动 tag + staging + lid', async () => {
    const r = await call({
      nodes: [
        { id: 'a', text: '林凡' },
        { id: 'b', text: '**张伟**（带 md 记号自动认 md）' },
      ],
      edges: [{ from: 'a', to: 'b', type: 'link' }],
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Sketch #sk-/);
    const board = await readBoard(pid);
    const texts = Object.entries(board.objects).filter(([id]) => id.startsWith('text:'));
    const a = texts.find(([, e]) => e.data?.lid === 'a');
    const b = texts.find(([, e]) => e.data?.lid === 'b');
    expect(a[1].staging).toBe(true);
    expect(a[1].tag).toMatch(/^sk-/);
    expect(b[1].data.format).toBe('md');     // 侦测出 md
    expect(a[1].data.format).toBeUndefined(); // 纯文字仍 plain
  });

  it('单节点 nodes 退化成板书文件（一句话是图的最小单位）', async () => {
    const r = await call({ nodes: [{ id: 'solo', text: '就一句话' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('Wrote board note');
  });

  it('layout free 缺 at：明拒并报名单（不再静默排成一列）', async () => {
    const r = await call({
      layout: 'free',
      nodes: [
        { id: 'x', text: 'aa', at: { x: 0, y: 0 } },
        { id: 'y', text: 'bb' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('y');
  });

  it('at 远场：拒收但不失败，返回说清楚（落位没有失败分支）', async () => {
    const r = await call({ text: '远方的话', at: { x: 900000, y: 900000 } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('outside the working area');
  });

  it('near 指向没座位但真实存在的文件：救援入座后照锚（「还没有座位」失败类收口）', async () => {
    await fs.mkdir(path.join(sharedRoot, '小说'), { recursive: true });
    await fs.writeFile(path.join(sharedRoot, '小说/序章.md'), '# 序章', 'utf8');
    const r = await call({ text: '这一章写得不错', near: '小说/序章.md' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.objects['小说/序章.md']).toBeTruthy();
    expect(board.objects['小说/序章.md'].seat).toBe('auto');
    const line = Object.values(board.bindings).find(b => b.to === '小说/序章.md' && b.type === 'annotates');
    expect(line).toBeTruthy();
  });

  it('near 指向确实不存在的东西：仍拒，错误话术说清三种可能', async () => {
    const r = await call({ text: 'x', near: '虚空锚点' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('磁盘上也没有');
  });

  it('text 与 nodes 同给：拒', async () => {
    const r = await call({ text: 'x', nodes: [{ id: 'n', text: 'y' }] });
    expect(r.isError).toBe(true);
  });

  it('sketch_on_board 别名与本尊同 handler', async () => {
    const alias = makeSketchOnBoardAlias({ projectId: pid, sharedRoot, sessionId: 's1', ctx: { emit: () => {} } });
    const r = await alias.handler({ nodes: [{ id: 'p', text: 'P' }, { id: 'q', text: 'Q' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Sketch #sk-/);
  });
});
