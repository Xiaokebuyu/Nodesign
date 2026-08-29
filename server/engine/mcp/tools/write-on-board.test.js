import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-writeboard-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeWriteOnBoardTool } = await import('./write-on-board.js');
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

  it('at = 纸内坐标（2026-08-29 纸范式）：自动铺纸；越界钳进版心并如实报', async () => {
    const r = await call({ text: '纸上定点', at: { x: 48, y: 48 } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/on sheet /);
    const board = await readBoard(pid);
    expect(Object.keys(board.sheets || {}).length).toBeGreaterThanOrEqual(1);
    const r2 = await call({ text: '越界的话', at: { x: 11999, y: 11999 } });
    expect(r2.isError).toBeUndefined();
    expect(r2.content[0].text).toContain('CLAMPED');
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

});

describe('open_lane：开新线（08-27 空间规划）', () => {
  it('⭐ branch：从节点岔出 —— 给这条线铺自己的纸、注册表落盘、flow 线画上', async () => {
    await patchBoard(pid, { objects: { 'assets/起点.png': { x: 3000, y: 3000, w: 200, h: 176 } } });
    const r = await call({ text: '岔出去想', tag: 'lane甲', open_lane: 'assets/起点.png' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Opened lane #lane甲/);
    const board = await readBoard(pid);
    expect(board.sheets['lane甲']).toBeTruthy();          // 一条线 = 它自己的一叠纸
    const lane = board.lanes['lane甲'];
    expect(lane).toBeTruthy();
    expect(lane.parent).toBe('assets/起点.png');
    const note = Object.entries(board.objects).find(([, e]) => e.tag === 'lane甲');
    expect(note[1].x).toBe(lane.x);                       // 注册点 = 线头
    const flow = Object.values(board.bindings).find(b => b.type === 'flow' && b.from === 'assets/起点.png' && b.to === note[0]);
    expect(flow).toBeTruthy();
  });

  it('续线走 {tag, chain:true}：落在同列线尾（frontier 语义）', async () => {
    const board0 = await readBoard(pid);
    const head = Object.entries(board0.objects).find(([, e]) => e.tag === 'lane甲');
    const r = await call({ text: '接着想第二节', tag: 'lane甲', chain: true });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const notes = Object.entries(board.objects).filter(([, e]) => e.tag === 'lane甲')
      .sort((a, b) => a[1].y - b[1].y);
    expect(notes.length).toBe(2);
    expect(notes[0][0]).toBe(head[0]);
    expect(notes[1][1].x).toBe(notes[0][1].x);            // 同列
    expect(notes[1][1].y).toBeGreaterThan(notes[0][1].y); // 线尾
  });

  it('⭐ 重开已有的线被拒并指路 chain；不带 tag 也拒', async () => {
    const r = await call({ text: 'x', tag: 'lane甲', open_lane: 'fresh' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/已经开过了/);
    const r2 = await call({ text: 'x', open_lane: 'fresh' });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/要配 tag/);
  });

  it('跟 reply_to/chain/at/near 互斥（岔出点写在 open_lane 里）', async () => {
    const r = await call({ text: 'x', tag: 'lane乙', open_lane: 'fresh', chain: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/互斥/);
  });

  it('fresh：全新话题另铺一张纸', async () => {
    const r = await call({ text: '全新话题', tag: 'lane乙', open_lane: 'fresh' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.lanes['lane乙'].parent).toBeUndefined();
    expect(board.sheets['lane乙']).toBeTruthy();
  });
});

describe("ink:'hand'（08-27 收编 create_on_board）+ 草图 hug", () => {
  it("⭐ hand 落画布原生 text 节点（无文件），near 线照画", async () => {
    await patchBoard(pid, { objects: { 'assets/hand锚.png': { x: 6000, y: 6000, w: 200, h: 176 } } });
    const r = await call({ text: '轻轻一句', ink: 'hand', near: 'assets/hand锚.png', font: 'pen', color: 'red' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/handwritten note text:/);
    const board = await readBoard(pid);
    const [hid, e] = Object.entries(board.objects).find(([, o]) => o.kind === 'text' && o.data?.t === '轻轻一句');
    expect(e.data.font).toBe('pen');
    expect(e.data.color).toBe('red');
    expect(Object.values(board.bindings).some(b => b.from === hid && b.to === 'assets/hand锚.png')).toBe(true);
  });

  it('hand 接不进线程：chain/reply_to/open_lane 一律拒且说清换 chalk', async () => {
    const r = await call({ text: 'x', ink: 'hand', chain: true, tag: 'lane甲' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/chalk/);
  });

  it('⭐ 草图里 around 包节点的形状落盘带 hug（指向节点的真 id）', async () => {
    const r = await call({
      tag: 'hug草图',
      nodes: [{ id: 'a', text: '被圈的' }, { id: 'b', text: '另一个' }],
      shapes: [{ id: 's1', kind: 'rect', around: 'a' }],
    });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const nid = Object.entries(board.objects).find(([, e]) => e.data?.lid === 'a' && e.tag === 'hug草图')[0];
    const hugger = Object.values(board.objects).find((e) => e.hug === nid);
    expect(hugger).toBeTruthy();
    expect(hugger.kind).toBe('scribble');
  });
});

describe('图的落位走纸（2026-08-29：产物锚自动落位退役，线照画）', () => {
  it('edges 连到已有产物：线照画，图落在纸上（位置不再追着产物跑）', async () => {
    await patchBoard(pid, { objects: { 'assets/被评的稿.png': { x: 9000, y: 9000, w: 200, h: 176 } } });
    const r = await call({
      nodes: [{ id: 'p1', text: '优点：构图稳' }, { id: 'p2', text: '缺点：主体太小' }, { id: 'v', text: '判语：改第二版' }],
      edges: [
        { from: 'p1', to: 'assets/被评的稿.png', type: 'annotates' },
        { from: 'p1', to: 'v' }, { from: 'p2', to: 'v' },
      ],
      tag: '评稿',
    });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const line = Object.values(board.bindings).find(b => b.type === 'annotates' && b.to === 'assets/被评的稿.png');
    expect(line).toBeTruthy();
    const members = Object.entries(board.objects).filter(([, e]) => e.tag === '评稿');
    expect(members.length).toBe(3);
  });

  it('显式 near/at 时产物锚不插手（显式优先）', async () => {
    const r = await call({
      nodes: [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }],
      edges: [{ from: 'a', to: 'assets/被评的稿.png' }],
      at: { x: 200, y: 200 }, tag: '显式位',
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/自动落在它们旁边/);
  });
});

describe('节点级拉力·集成向（08-27 v2）：mindmap 环位朝着真实产物', () => {
  it('⭐ 立绘在图的北边 → 评它的叶子占环的上侧（世界方位，单锚不退化）', async () => {
    // 先落一张图（产物锚会把 sketch 落在立绘旁），立绘在 (20000, 20000)
    await patchBoard(pid, { objects: { 'assets/立绘北.png': { x: 20000, y: 20000, w: 200, h: 176 } } });
    const r = await call({
      layout: 'mindmap',
      nodes: [
        { id: 'hub', text: '角色小传' },
        { id: 'x1', text: '性格' }, { id: 'x2', text: '经历' }, { id: 'face', text: '外貌（见立绘）' },
      ],
      edges: [
        { from: 'hub', to: 'x1' }, { from: 'hub', to: 'x2' }, { from: 'hub', to: 'face' },
        { from: 'face', to: 'assets/立绘北.png', type: 'annotates' },
      ],
      tag: '小传',
    });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const of = (lid) => Object.values(board.objects).find((e) => e.data?.lid === lid);
    const hub = of('hub'); const face = of('face');
    const art = board.objects['assets/立绘北.png'];
    // face 的中心相对 hub 中心的方向，和 立绘相对 hub 的方向同侧（内积为正）
    const v1 = { x: (face.x + face.w / 2) - (hub.x + hub.w / 2), y: (face.y + face.h / 2) - (hub.y + hub.h / 2) };
    const v2 = { x: (art.x + art.w / 2) - (hub.x + hub.w / 2), y: (art.y + art.h / 2) - (hub.y + hub.h / 2) };
    expect(v1.x * v2.x + v1.y * v2.y).toBeGreaterThan(0);
  });
});

describe('接楼（2026-08-29 纸范式：方向学习退役，读序只有向下）', () => {
  it('用户把线程往右拖过 → chain 仍接在最新一条正下方（inferFlowDir 已退役）', async () => {
    // proj_mtbkhpac 实案的形状：flow 线一路向右，下游都是用户亲手放的
    await patchBoard(pid, {
      objects: {
        'notes/板书/dir-0001-一.md': { x: 9000, y: 9000, w: 400, h: 220, by: 'agent', tag: '向右线', seat: 'agent' },
        'notes/板书/dir-0002-二.md': { x: 9560, y: 9020, w: 400, h: 220, by: 'agent', tag: '向右线', seat: 'user' },
        'notes/板书/dir-0003-三.md': { x: 10120, y: 9000, w: 400, h: 220, by: 'agent', tag: '向右线', seat: 'user' },
      },
      bindings: {
        'b:dir1': { type: 'flow', from: 'notes/板书/dir-0001-一.md', to: 'notes/板书/dir-0002-二.md', tag: '向右线' },
        'b:dir2': { type: 'flow', from: 'notes/板书/dir-0002-二.md', to: 'notes/板书/dir-0003-三.md', tag: '向右线' },
      },
    });
    const r = await call({ text: '第四节', tag: '向右线', chain: true });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const id = Object.keys(board.objects).filter(i => i.startsWith('notes/板书/') && board.objects[i].tag === '向右线' && !i.startsWith('notes/板书/dir-')).pop();
    const e = board.objects[id];
    // 正下方同列（接楼只有一个方向 —— 读序）
    expect(e.x).toBe(10120);
    expect(e.y).toBeGreaterThanOrEqual(9000 + 220);
    void r;
  });

  it('用户没表达过方向偏好 → chain 仍是缺省正下方（拿不准就不押）', async () => {
    await patchBoard(pid, {
      objects: {
        'notes/板书/plain-0001.md': { x: 20000, y: 20000, w: 400, h: 220, by: 'agent', tag: '竖线', seat: 'agent' },
      },
    });
    const r = await call({ text: '第二节', tag: '竖线', chain: true });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const id = Object.keys(board.objects).filter(i => i.startsWith('notes/板书/') && board.objects[i].tag === '竖线' && !i.startsWith('notes/板书/plain-')).pop();
    const e = board.objects[id];
    expect(e.y).toBeGreaterThanOrEqual(20000 + 220);   // 正下方
    expect(Math.abs(e.x - 20000)).toBeLessThan(120);   // 同列
  });
});
