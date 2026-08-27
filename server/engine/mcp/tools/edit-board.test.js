import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-editboard-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeEditBoardTool, makeArrangeOnBoardAlias, makeRelateOnBoardAlias } = await import('./edit-board.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');

const pid = 'proj_editboard_test';
let sharedRoot;
let edit; let write;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
  const ctx = { emit: () => {} };
  edit = (args) => makeEditBoardTool({ projectId: pid, sharedRoot, ctx }).handler(args);
  write = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx }).handler(args);
});

describe('edit_board（吞四件 + 新能力）', () => {
  it('set_edge 改端点：重指一条命令（RP「状态锚在这一章」案）', async () => {
    await write({ nodes: [{ id: 'ch1', text: '第一章' }, { id: 'ch2', text: '第二章' }, { id: 'status', text: '状态板' }], tag: 'rp' });
    let board = await readBoard(pid);
    const idOf = (lid) => Object.entries(board.objects).find(([, e]) => e.data?.lid === lid)?.[0];
    const r0 = await edit({ tag: 'rp', ops: [{ op: 'add_edge', from: 'status', to: 'ch1', type: 'annotates', label: '状态锚' }] });
    expect(r0.isError).toBeUndefined();
    board = await readBoard(pid);
    const [edgeId, e0] = Object.entries(board.bindings).find(([, b]) => b.label === '状态锚');
    expect(e0.to).toBe(idOf('ch1'));
    const r1 = await edit({ tag: 'rp', ops: [{ op: 'set_edge', id: edgeId, to: 'ch2' }] });
    expect(r1.isError).toBeUndefined();
    board = await readBoard(pid);
    expect(board.bindings[edgeId].to).toBe(idOf('ch2'));
    expect(board.bindings[edgeId].from).toBe(idOf('status'));
  });

  it('set_edge 新端点不存在：拒这一条，其余照做', async () => {
    const board = await readBoard(pid);
    const edgeId = Object.keys(board.bindings)[0];
    const r = await edit({ ops: [{ op: 'set_edge', id: edgeId, to: '不存在的东西' }, { op: 'unfeature' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('✗ #1');
  });

  it('reflow：set_text 改高后整组按 column 重堆，不再叠字（RP 状态板案）', async () => {
    await write({
      layout: 'column', tag: 'panel', staging: false,
      nodes: [{ id: 'pc', text: 'PC 卡' }, { id: 'scene', text: '当前场景' }, { id: 'dice', text: '骰子记录' }],
    });
    let board = await readBoard(pid);
    const idOf = (lid) => Object.entries(board.objects).find(([, e]) => e.data?.lid === lid)?.[0];
    const long = Array.from({ length: 12 }, (_, i) => `| 第${i}章 | 检定 | DC | 结果 |`).join('\n');
    const r = await edit({ tag: 'panel', ops: [{ op: 'set_text', id: 'scene', text: long, format: 'md' }, { op: 'reflow', tag: 'panel' }] });
    expect(r.isError).toBeUndefined();
    board = await readBoard(pid);
    const scene = board.objects[idOf('scene')];
    const dice = board.objects[idOf('dice')];
    // 骰子记录被推到变高后的场景卡下面，不重叠
    expect(dice.y).toBeGreaterThanOrEqual(scene.y + scene.h);
  });

  it('reflow 跳过用户拖过的（seat:user 永不被重排）', async () => {
    let board = await readBoard(pid);
    const idOf = (lid) => Object.entries(board.objects).find(([, e]) => e.data?.lid === lid)?.[0];
    const diceId = idOf('dice');
    await patchBoard(pid, { objects: { [diceId]: { x: 5000, y: 5000, seat: 'user' } } });
    const r = await edit({ ops: [{ op: 'reflow', tag: 'panel' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('跳过用户拖过的');
    board = await readBoard(pid);
    expect(board.objects[diceId].x).toBe(5000);
  });

  it('remove：agent 自己的板书放行，文件+座位一起清', async () => {
    await write({ text: '临时便签，一会儿删' });
    let board = await readBoard(pid);
    const chalkId = Object.keys(board.objects).filter(id => id.startsWith('notes/板书/')).sort().pop();
    const abs = path.join(sharedRoot, chalkId);
    await fs.access(abs);   // 文件在
    const r = await edit({ ops: [{ op: 'remove', id: chalkId }] });
    expect(r.isError).toBeUndefined();
    board = await readBoard(pid);
    expect(board.objects[chalkId]).toBeUndefined();
    await expect(fs.access(abs)).rejects.toThrow();
    // 软删：真身进了 .nd/trash/<日期>/（08-25 信箱：rm 后无法恢复案）
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const trashed = await fs.readdir(path.join(sharedRoot, '.nd', 'trash', day));
    expect(trashed.some(n => n === path.basename(abs))).toBe(true);
  });

  it('remove：用户的板书拒删', async () => {
    await patchBoard(pid, { objects: { 'notes/板书/user-note.md': { x: 0, y: 0, by: 'user' } } });
    const r = await edit({ ops: [{ op: 'remove', id: 'notes/板书/user-note.md' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('用户的板书');
  });

  it('add_edge：端点校验下沉（不存在拒；磁盘真身收）', async () => {
    await fs.writeFile(path.join(sharedRoot, '真实文件.md'), 'x', 'utf8');
    const bad = await edit({ ops: [{ op: 'add_edge', from: '真实文件.md', to: '虚空端点' }] });
    expect(bad.isError).toBe(true);
    await patchBoard(pid, { objects: { 'assets/photo.png': { x: 10, y: 10 } } });
    const good = await edit({ ops: [{ op: 'add_edge', from: '真实文件.md', to: 'assets/photo.png', type: 'ref' }] });
    expect(good.isError).toBeUndefined();
  });

  it('move 有避让：目标位被占就近落，返回说清楚', async () => {
    await patchBoard(pid, { objects: {
      'assets/a.png': { x: 9000, y: 9000, w: 200, h: 176 },
      'assets/b.png': { x: 9224, y: 9000, w: 200, h: 176 },   // 正占着 a 的右侧
      'assets/c.png': { x: 20000, y: 20000, w: 200, h: 176 },
    } });
    const r = await edit({ ops: [{ op: 'move', id: 'assets/c.png', to: { ref: 'assets/a.png', side: 'right' } }] });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const c = board.objects['assets/c.png'];
    const b = board.objects['assets/b.png'];
    // 不压在 b 上
    expect(c.x + 200 <= b.x || b.x + 200 <= c.x || c.y + 176 <= b.y || b.y + 176 <= c.y).toBe(true);
    expect(c.seat).toBe('agent');
  });

  it('feature/unfeature（吞 arrange）+ commit/erase_group（吞 finish）', async () => {
    const r = await edit({ ops: [{ op: 'feature', id: 'assets/photo.png' }] });
    expect(r.isError).toBeUndefined();
    let board = await readBoard(pid);
    expect(board.hero).toBe('assets/photo.png');
    await edit({ ops: [{ op: 'unfeature' }] });
    board = await readBoard(pid);
    expect(board.hero).toBeUndefined();

    await write({ nodes: [{ id: 'x1', text: 'X' }, { id: 'x2', text: 'Y' }], tag: 'wipe' });
    const c = await edit({ ops: [{ op: 'commit', tag: 'wipe' }] });
    expect(c.content[0].text).toContain('落定');
    const e = await edit({ ops: [{ op: 'erase_group', tag: 'wipe' }] });
    expect(e.content[0].text).toContain('擦掉');
    board = await readBoard(pid);
    expect(Object.values(board.objects).some(o => o.tag === 'wipe')).toBe(false);
  });

  it('arrange_on_board 别名：beside 转发 move', async () => {
    const alias = makeArrangeOnBoardAlias({ projectId: pid, sharedRoot, ctx: { emit: () => {} } });
    const r = await alias.handler({ action: 'beside', subject: 'assets/photo.png', anchor: 'assets/a.png' });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.objects['assets/photo.png'].x).toBeGreaterThan(9000);
  });

  it('relate_on_board 别名：悬空端点照拒（口径病收口）', async () => {
    const alias = makeRelateOnBoardAlias({ projectId: pid, sharedRoot, ctx: { emit: () => {} } });
    const bad = await alias.handler({ type: 'ref', from: 'assets/photo.png', to: 'relations' });
    expect(bad.isError).toBe(true);
    const good = await alias.handler({ type: 'contrast', from: 'assets/a.png', to: 'assets/b.png' });
    expect(good.isError).toBeUndefined();
  });
});

describe('08-25 二批：gap 单位收口 + chalk_edit + 挪动如实报', () => {
  it('gap 灾难防线仍在（40 格=960px 案）：解析后的 gap 永不超 8 格', async () => {
    // 08-27 语义改：>8 不再整单拒收，按像素收编（见 schema 垫片那组用例）。
    // 这条测试的真意图 —— 巨大 gap 不可能落到板上 —— 换个断言继续钉着。
    const { z } = await import('zod');
    const t = makeEditBoardTool({ projectId: pid, sharedRoot, ctx: { emit: () => {} } });
    const parse = (gap) => z.object(t.inputSchema).safeParse({ ops: [{ op: 'move', id: 'x', to: { ref: 'y', side: 'right', gap } }] });
    for (const g of [8, 9, 40, 960, 99999]) {
      const p = parse(g);
      expect(p.success, `gap:${g} 该放行`).toBe(true);
      expect(p.data.ops[0].to.gap, `gap:${g} 解析后越界`).toBeLessThanOrEqual(8);
    }
  });

  it('move/move_group 结果报落点（Applied 1/1 什么都不说的病）', async () => {
    const r = await edit({ ops: [{ op: 'move', id: 'assets/a.png', to: { dx: 2, dy: 0 } }] });
    expect(r.content[0].text).toMatch(/move → \(-?\d+,-?\d+\)/);
    const g = await edit({ ops: [{ op: 'move_group', tag: 'panel', to: { dx: 1, dy: 1 } }] });
    expect(g.content[0].text).toMatch(/move_group #panel → 组左上 \(-?\d+,-?\d+\)/);
  });

  it('chalk_edit：写 ui-config 并广播事件', async () => {
    const events = [];
    const t = makeEditBoardTool({ projectId: pid, sharedRoot, ctx: { emit: (e) => events.push(e) } });
    const r = await t.handler({ ops: [{ op: 'chalk_edit', on: true }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('改板书开关 → 开');
    const cfg = JSON.parse(await fs.readFile(path.join(sharedRoot, 'ui-config.json'), 'utf8'));
    expect(cfg.chalk_edit).toBe(true);
    expect(events.some(e => e.type === 'ui.chalk_edit' && e.on === true)).toBe(true);
  });
});

describe('shapes 编辑面（08-27）：事后圈重点 + 贴身跟随', () => {
  it('⭐ add_shape 圈住已有节点，hug 记在案；move 节点圈跟着走', async () => {
    await write({ nodes: [{ id: 'k1', text: '要圈的重点' }, { id: 'k2', text: '陪跑' }], tag: 'hug试' });
    let board = await readBoard(pid);
    const nid = Object.entries(board.objects).find(([, e]) => e.data?.lid === 'k1')[0];
    const r = await edit({ ops: [{ op: 'add_shape', kind: 'ellipse', around: nid, color: 'red' }] });
    expect(r.isError).toBeUndefined();
    board = await readBoard(pid);
    const [sid, sh] = Object.entries(board.objects).find(([, e]) => e.hug === nid);
    expect(sh.kind).toBe('scribble');
    expect(sh.data.color).toBe('red');
    const rel = { dx: sh.x - board.objects[nid].x, dy: sh.y - board.objects[nid].y };
    // 挪节点：圈按同 delta 跟走（相对位置不变）
    await edit({ ops: [{ op: 'move', id: nid, to: { dx: 10, dy: 5 } }] });
    board = await readBoard(pid);
    expect(board.objects[sid].x - board.objects[nid].x).toBe(rel.dx);
    expect(board.objects[sid].y - board.objects[nid].y).toBe(rel.dy);
  });

  it('⭐ reflow 不再散架：文字重排时圈着它的记号一起走', async () => {
    let board = await readBoard(pid);
    const nid = Object.entries(board.objects).find(([, e]) => e.data?.lid === 'k1')[0];
    const [sid] = Object.entries(board.objects).find(([, e]) => e.hug === nid);
    const relBefore = { dx: board.objects[sid].x - board.objects[nid].x, dy: board.objects[sid].y - board.objects[nid].y };
    const r = await edit({ ops: [{ op: 'reflow', tag: 'hug试', layout: 'row' }] });
    expect(r.isError).toBeUndefined();
    board = await readBoard(pid);
    expect(board.objects[sid].x - board.objects[nid].x).toBe(relBefore.dx);
    expect(board.objects[sid].y - board.objects[nid].y).toBe(relBefore.dy);
  });

  it('set_shape 改色改粗；对非涂鸦拒', async () => {
    const board = await readBoard(pid);
    const [sid] = Object.entries(board.objects).find(([, e]) => e.kind === 'scribble' && e.hug);
    const r = await edit({ ops: [{ op: 'set_shape', id: sid, color: 'brass', width: 4 }] });
    expect(r.isError).toBeUndefined();
    const after = await readBoard(pid);
    expect(after.objects[sid].data.color).toBe('brass');
    expect(after.objects[sid].data.width).toBe(4);
    const nid = Object.entries(after.objects).find(([, e]) => e.data?.lid === 'k1')[0];
    const r2 = await edit({ ops: [{ op: 'set_shape', id: nid, color: 'red' }] });
    expect(r2.content[0].text).toMatch(/不是手画记号/);
  });
});

describe('板书正门（08-27）：set_text 认板书文件，笔权按作者判', () => {
  it('⭐ 改自己的板书 = 重写文件正文，frontmatter 章保留', async () => {
    await write({ text: '初版正文', tag: '正门试' });
    let board = await readBoard(pid);
    const [cid] = Object.entries(board.objects).find(([id, e]) => id.startsWith('notes/板书/') && e.tag === '正门试');
    const r = await edit({ ops: [{ op: 'set_text', id: cid, text: '改过的正文，比初版长了一些，高度会重估' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/重写了板书/);
    const raw = await fs.readFile(path.join(sharedRoot, cid), 'utf8');
    expect(raw).toContain('改过的正文');
    expect(raw).toContain('nd: chalk');
    expect(raw).not.toContain('初版正文');
    board = await readBoard(pid);
    expect(board.objects[cid].tag).toBe('正门试');   // 座位字段没被抹
  });

  it('⭐ 改别人的板书被拒（笔权），产物卡照旧拒', async () => {
    const board = await readBoard(pid);
    const [cid] = Object.entries(board.objects).find(([id, e]) => id.startsWith('notes/板书/') && e.tag === '正门试');
    await patchBoard(pid, { objects: { [cid]: { by: 'rp-someone' } } });
    const r = await edit({ ops: [{ op: 'set_text', id: cid, text: '主控想代笔' }] });
    expect(r.content[0].text).toMatch(/笔权/);
    await patchBoard(pid, { objects: { [cid]: { by: 'agent' } } });
  });
});

describe('用户座位不可撼动（08-27 审计修：move/move_group 补上教义早已承诺的闸）', () => {
  it('⭐ move 用户拖过的东西被拒，位置和 seat 纹丝不动', async () => {
    await patchBoard(pid, { objects: { 'assets/用户摆的.png': { x: 50, y: 50, w: 100, h: 80, seat: 'user' } } });
    const r = await edit({ ops: [{ op: 'move', id: 'assets/用户摆的.png', to: { dx: 5, dy: 5 } }] });
    expect(r.content[0].text).toMatch(/用户亲手摆/);
    const board = await readBoard(pid);
    expect(board.objects['assets/用户摆的.png'].x).toBe(50);
    expect(board.objects['assets/用户摆的.png'].seat).toBe('user');
  });

  it('move_group 跳过用户座、其余照走并如实报（同 reflow 的纪律）', async () => {
    await patchBoard(pid, { objects: {
      'assets/g1.png': { x: 1000, y: 1000, w: 100, h: 80, tag: '守座', seat: 'agent' },
      'assets/g2.png': { x: 1000, y: 1200, w: 100, h: 80, tag: '守座', seat: 'user' },
    } });
    const r = await edit({ ops: [{ op: 'move_group', tag: '守座', to: { dx: 10, dy: 0 } }] });
    expect(r.content[0].text).toMatch(/跳过用户亲手摆/);
    const board = await readBoard(pid);
    expect(board.objects['assets/g1.png'].x).toBe(1240);   // 10 格 × 24px
    expect(board.objects['assets/g2.png'].x).toBe(1000);   // 用户座原地
    expect(board.objects['assets/g2.png'].seat).toBe('user');
  });
});

/**
 * 单位/方言垫片（08-27 转录对账案）。真会话里 edit_board 占全家族 -32602 六成，
 * 三族错误：gap 填像素（gap:40）、dx 填像素（dx:-11064）、弱模型给端点裹 {$text} 壳
 * 且读不懂 zod 报文原样重试到死。垫片都在 **schema 层**（z.preprocess），直接调
 * handler 测不到 —— 这里按 SDK 的路径走一遍 z.object(inputSchema).parse。
 */
describe('schema 垫片：像素收编 + $text 剥壳', () => {
  let parse; let editT;
  beforeAll(async () => {
    const { z } = await import('zod');
    editT = makeEditBoardTool({ projectId: pid, sharedRoot, ctx: { emit: () => {} } });
    parse = (args) => z.object(editT.inputSchema).parse(args);
  });

  it('⭐ gap:40 是像素思维（真会话头号错误）：换算成格放行，不整单拒收', () => {
    const p = parse({ ops: [{ op: 'move', id: 'x', to: { ref: 'y', side: 'right', gap: 40 } }] });
    expect(p.ops[0].to.gap).toBeCloseTo(40 / 24, 5);
    // 巨大的像素值钳到上限 8 格；合法格数原样过
    expect(parse({ ops: [{ op: 'move', id: 'x', to: { ref: 'y', side: 'right', gap: 300 } }] }).ops[0].to.gap).toBe(8);
    expect(parse({ ops: [{ op: 'move', id: 'x', to: { ref: 'y', side: 'right', gap: 3 } }] }).ops[0].to.gap).toBe(3);
    // 负数照旧拒 —— 方向由 side 表达，负 gap 没有合法意图
    expect(() => parse({ ops: [{ op: 'move', id: 'x', to: { ref: 'y', side: 'right', gap: -2 } }] })).toThrow();
  });

  it('⭐ dx:-11064 是像素位移（真会话案）：换算成格，端到端落点就是意图的像素数', async () => {
    const p = parse({ ops: [{ op: 'move', id: 'x', to: { dx: -11064, dy: 0 } }] });
    expect(p.ops[0].to.dx).toBe(-11064 / 24);   // -461 格，×24 还原回 -11064px
    await patchBoard(pid, { objects: { 'assets/远块.png': { x: 30000, y: 30000, w: 100, h: 80, seat: 'agent' } } });
    const r = await editT.handler(parse({ ops: [{ op: 'move', id: 'assets/远块.png', to: { dx: -11064, dy: 0 } }] }));
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.objects['assets/远块.png'].x).toBe(30000 - 11064);
    // 合法格数不动；换算后仍超 ±2000 格的钳到边界
    expect(parse({ ops: [{ op: 'move', id: 'x', to: { dx: -5, dy: 1999 } }] }).ops[0].to).toEqual({ dx: -5, dy: 1999 });
    expect(parse({ ops: [{ op: 'move', id: 'x', to: { dx: -99999999, dy: 0 } }] }).ops[0].to.dx).toBe(-2000);
  });

  it('⭐ add_edge 端点 {$text:"…"} 剥壳（弱模型方言，真会话重试到死案）：线真的画上', async () => {
    const p = parse({ ops: [{ op: 'add_edge', from: 'a', to: { $text: 'b' }, type: 'link' }] });
    expect(p.ops[0].to).toBe('b');
    await patchBoard(pid, { objects: {
      'assets/端a.png': { x: 40000, y: 40000, w: 100, h: 80 },
      'assets/端b.png': { x: 40200, y: 40000, w: 100, h: 80 },
    } });
    const r = await editT.handler(parse({ ops: [{ op: 'add_edge', from: 'assets/端a.png', to: { $text: 'assets/端b.png' }, type: 'link', label: '剥壳线' }] }));
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid);
    const edge = Object.values(board.bindings).find(b => b.label === '剥壳线');
    expect(edge.to).toBe('assets/端b.png');
    // set_edge 的端点同享；非 $text 单键对象照旧拒（剥壳只认这一种方言，不是松类型）
    expect(parse({ ops: [{ op: 'set_edge', id: 'e', to: { $text: 'c' } }] }).ops[0].to).toBe('c');
    expect(() => parse({ ops: [{ op: 'add_edge', from: 'a', to: { ref: 'b', side: 'right' } }] })).toThrow();
    expect(() => parse({ ops: [{ op: 'add_edge', from: 'a', to: { $text: 'b', extra: 1 } }] })).toThrow();
  });

  it('垫片在给模型看的 JSON schema 里隐形：字段仍是带上下限的 number/string', async () => {
    const { z } = await import('zod');
    const js = z.toJSONSchema(z.object(editT.inputSchema), { io: 'input' });
    const moveBranch = js.properties.ops.items.oneOf.find(b => b.properties?.op?.const === 'move');
    const rel = moveBranch.properties.to.anyOf.find(b => b.properties?.gap);
    expect(rel.properties.gap).toMatchObject({ type: 'number', minimum: 0, maximum: 8 });
    const edgeBranch = js.properties.ops.items.oneOf.find(b => b.properties?.op?.const === 'add_edge');
    expect(edgeBranch.properties.to).toMatchObject({ type: 'string', minLength: 1, maxLength: 300 });
  });
});

/**
 * 收纳器（2026-08-27）：roll 只立状态位，成员座位一件不动 —— 展开即归位的根据。
 */
describe('roll / unroll（收纳器）', () => {
  it('⭐ 收卷：rolls 立条目、座位原样、展开后条目消失', async () => {
    await patchBoard(pid, { objects: {
      'notes/板书/20260827-180000-第一幕a.md': { x: 50000, y: 50000, w: 300, h: 100, by: 'agent', tag: '第一幕' },
      'notes/板书/20260827-180001-第一幕b.md': { x: 50000, y: 50200, w: 300, h: 100, by: 'agent', tag: '第一幕' },
    } });
    const r = await edit({ ops: [{ op: 'roll', tag: '第一幕', label: '开场' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/收进卷里（2 件/);
    let board = await readBoard(pid);
    expect(board.rolls['第一幕']).toMatchObject({ label: '开场' });
    // 座位一动不动 —— 这是「展开即归位」和「落位不落错」共同的根据
    expect(board.objects['notes/板书/20260827-180000-第一幕a.md'].x).toBe(50000);
    expect(board.objects['notes/板书/20260827-180001-第一幕b.md'].y).toBe(50200);
    // 再收一遍：幂等，如实报
    const r2 = await edit({ ops: [{ op: 'roll', tag: '第一幕' }] });
    expect(r2.content[0].text).toMatch(/本来就收着/);
    const r3 = await edit({ ops: [{ op: 'unroll', tag: '第一幕' }] });
    expect(r3.isError).toBeUndefined();
    board = await readBoard(pid);
    expect(board.rolls).toBeUndefined();
    expect(board.objects['notes/板书/20260827-180000-第一幕a.md'].x).toBe(50000);
  });

  it('空组收不了；没收着的展不开', async () => {
    const r = await edit({ ops: [{ op: 'roll', tag: '不存在的组' }] });
    expect(r.isError).toBe(true);
    const r2 = await edit({ ops: [{ op: 'unroll', tag: '第一幕' }] });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/没收着/);
  });

  it('erase_group 连卷的状态位一起清（不留空卷卡）', async () => {
    await patchBoard(pid, { objects: {
      'notes/板书/20260827-181000-废幕.md': { x: 60000, y: 60000, w: 300, h: 100, by: 'agent', tag: '废幕' },
    } });
    await edit({ ops: [{ op: 'roll', tag: '废幕' }] });
    expect((await readBoard(pid)).rolls?.['废幕']).toBeTruthy();
    await edit({ ops: [{ op: 'erase_group', tag: '废幕' }] });
    expect((await readBoard(pid)).rolls?.['废幕']).toBeUndefined();
  });
});
