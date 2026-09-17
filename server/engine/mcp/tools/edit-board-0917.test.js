/**
 * edit_board 09-17 一批（问题库）：
 *   C  线的端点先归一再校验（iss_mtgcjmnf_tye4）：摘要印的 `X（site）`、裸站点目录名、`xx/index.html`、
 *      站点里的文件都认成站点卡；认完画不出来的（不存在 / 不上画布 / 文件已删的座位）拒并给候选
 *   F  set_tag 收线 id（iss_mttyszj1_rrp6）
 *   G  add_node 的 at 可省（iss_mtfh3t44_kjdf 参数族）
 *   H  像素写法明确报错，不只回 Unrecognized key
 *   附 set_edge 清 label / 回默认墨线真的落盘（线是合并语义，delete 键会被旧值补回来）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-editboard0917-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { z } = await import('zod');
const { makeEditBoardTool } = await import('./edit-board.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { relationsDigest, describeEndpoint } = await import('../../../lib/board-relations.js');

const pid = 'proj_editboard_0917';
let root; let edit; let write; let parse;
const put = async (rel, body = 'x') => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); };
const edgeTo = async (label) => Object.entries((await readBoard(pid)).bindings).find(([, b]) => b.label === label);

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  root = getSharedDir(pid);
  const ctx = { emit: () => {} };
  const tool = makeEditBoardTool({ projectId: pid, sharedRoot: root, ctx });
  edit = (args) => tool.handler(args, {});
  write = (args) => makeWriteOnBoardTool({ projectId: pid, sharedRoot: root, sessionId: 's1', ctx }).handler(args);
  parse = (args) => z.object(tool.inputSchema).parse(args);
  await put('十三机兵防卫圈/index.html', '<html><body>x</body></html>');
  await put('十三机兵防卫圈/css/a.css', 'a{}');
  await put('角色档案站/index.html', '<html><body>y</body></html>');
  await put('assets/封面.png');
  await put('小说/第一章.md', '# 一');
  await put('exports/交付.zip');
  await patchBoard(pid, { objects: {
    'site:角色档案站': { x: 0, y: 0, w: 640, h: 400 },
    'assets/封面.png': { x: 800, y: 0, w: 200, h: 176 },
    'assets/已删.png': { x: 1200, y: 0, w: 200, h: 176 },   // 文件不在：幽灵座位
  } });
});

describe('C 线的端点：归一后必须画得出来', () => {
  it('⭐ 摘要印的写法原样抄回来能连上（真案：`X（site）` / 裸站点目录名 / index.html / 站点里的文件）', async () => {
    const cases = [
      ['角色档案站（site）', 'site:角色档案站', 'c1'],
      ['角色档案站/index.html', 'site:角色档案站', 'c2'],
      ['十三机兵防卫圈', 'site:十三机兵防卫圈', 'c3'],               // 站点还没座位：当场入座，连站点卡，不存裸目录名
      ['十三机兵防卫圈/css/a.css', 'site:十三机兵防卫圈', 'c4'],
    ];
    for (const [raw, want, label] of cases) {
      const r = await edit({ ops: [{ op: 'add_edge', from: 'assets/封面.png', to: raw, label }] });
      expect(r.isError, `${raw}: ${r.content[0].text}`).toBeUndefined();
      const [, b] = await edgeTo(label);
      expect(b.to, raw).toBe(want);
    }
    const board = await readBoard(pid);
    expect(Number.isFinite(board.objects['site:十三机兵防卫圈']?.x)).toBe(true);   // 入座落了盘，前端有卡可画
    expect(board.objects['十三机兵防卫圈']).toBeUndefined();                          // 没把目录当文件卡坐
    // 摘要里印的就是能回填的 id
    const digest = await relationsDigest(pid);
    expect(digest).toContain('site:角色档案站');
    expect(digest).not.toContain('角色档案站（site）');
  });

  it('⭐ 同名文件夹坐标（入座器旧账）被站点卡遮住时连站点卡', async () => {
    await patchBoard(pid, { zones: { 角色档案站: { x: 5000, y: 5000 } } });
    const r = await edit({ ops: [{ op: 'add_edge', from: 'assets/封面.png', to: '角色档案站', label: 'z1' }] });
    expect(r.isError).toBeUndefined();
    expect((await edgeTo('z1'))[1].to).toBe('site:角色档案站');
    await patchBoard(pid, { zones: { 角色档案站: null } });
  });

  it('⭐ 摘要里印的手写字（内容 + id）整段抄回来也连得上（没有磁盘身份，只能靠括注里的 id）', async () => {
    await edit({ ops: [{ op: 'add_node', id: 'hw', text: '这版更暗' }] });
    const board = await readBoard(pid);
    const [tid] = Object.entries(board.objects).find(([, o]) => o.data?.lid === 'hw');
    const printed = describeEndpoint(tid, board);
    expect(printed).toContain(tid);
    const r = await edit({ ops: [{ op: 'add_edge', from: printed, to: 'assets/封面.png', label: 'hw1' }] });
    expect(r.isError, r.content[0].text).toBeUndefined();
    expect((await edgeTo('hw1'))[1].from).toBe(tid);
  });

  it('真文件夹当端点照收（裸路径就是文件夹卡的 id）', async () => {
    const r = await edit({ ops: [{ op: 'add_edge', from: 'assets/封面.png', to: '小说', label: 'f1' }] });
    expect(r.isError, r.content[0].text).toBeUndefined();
    expect((await edgeTo('f1'))[1].to).toBe('小说');
  });

  it('⭐ 画不出来的拒：不存在（带候选）、不上画布的位置、文件已删的座位', async () => {
    const miss = await edit({ ops: [{ op: 'add_edge', from: 'assets/封面.png', to: '角色档案馆' }] });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain('磁盘上也没有');
    expect(miss.content[0].text).toContain('最像的：site:角色档案站');
    const hidden = await edit({ ops: [{ op: 'add_edge', from: 'assets/封面.png', to: 'exports/交付.zip' }] });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toContain('不作为一张卡上画布');
    const ghost = await edit({ ops: [{ op: 'add_edge', from: 'assets/封面.png', to: 'assets/已删.png' }] });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0].text).toContain('文件已不在磁盘上');
    const board = await readBoard(pid);
    expect(Object.values(board.bindings).some((b) => ['角色档案馆', 'exports/交付.zip', 'assets/已删.png'].includes(b.to))).toBe(false);
  });

  it('set_edge 改端点同一份归一；清 label / 回默认墨线真的落盘', async () => {
    const [id] = await edgeTo('c1');
    await edit({ ops: [{ op: 'set_edge', id, material: 'yarn' }] });
    expect((await readBoard(pid)).bindings[id].material).toBe('yarn');
    const r = await edit({ ops: [{ op: 'set_edge', id, to: '十三机兵防卫圈（site）', label: '', material: 'ink' }] });
    expect(r.isError, r.content[0].text).toBeUndefined();
    const b = (await readBoard(pid)).bindings[id];
    expect(b.to).toBe('site:十三机兵防卫圈');
    expect(b.label).toBeUndefined();
    expect(b.material).toBeUndefined();
    const bad = await edit({ ops: [{ op: 'set_edge', id, to: '角色档案馆' }] });
    expect(bad.isError).toBe(true);
    expect((await readBoard(pid)).bindings[id].to).toBe('site:十三机兵防卫圈');
  });

  it('write_on_board 图内边走同一份：外部端点的自然叫法连得上，认不出的报原因', async () => {
    const r = await write({
      nodes: [{ id: 'n1', text: '甲' }, { id: 'n2', text: '乙' }],
      edges: [{ from: 'n1', to: '角色档案站（site）', type: 'annotates' }, { from: 'n2', to: '角色档案馆' }],
      tag: 'wob0917',
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('磁盘上也没有');
    const board = await readBoard(pid);
    expect(Object.values(board.bindings).some((b) => b.type === 'annotates' && b.to === 'site:角色档案站')).toBe(true);
  });
});

describe('F set_tag 收线 id', () => {
  it('⭐ 线进组：erase_group 连它一起擦；tag:"" 摘掉', async () => {
    const [id] = await edgeTo('f1');
    const r = await edit({ ops: [{ op: 'set_tag', ids: [id], tag: '线组' }] });
    expect(r.isError, r.content[0].text).toBeUndefined();
    expect(r.content[0].text).toContain('1 条线');
    expect((await readBoard(pid)).bindings[id].tag).toBe('线组');
    await edit({ ops: [{ op: 'set_tag', ids: [id], tag: '' }] });
    expect((await readBoard(pid)).bindings[id].tag).toBeUndefined();
    await edit({ ops: [{ op: 'set_tag', ids: [id, 'assets/封面.png'], tag: '线组' }] });
    const e = await edit({ ops: [{ op: 'erase_group', tag: '线组' }] });
    expect(e.isError).toBeUndefined();
    const board = await readBoard(pid);
    expect(board.bindings[id]).toBeUndefined();
    expect(board.objects['assets/封面.png']).toBeTruthy();   // 产物卡只摘标签
  });

  it('不存在的线 id 照旧报不在板上', async () => {
    const r = await edit({ ops: [{ op: 'set_tag', ids: ['b:nope'], tag: 'x' }] });
    expect(r.isError).toBe(true);
  });
});

describe('G add_node 的 at 可省；H 像素写法明确报错', () => {
  it('⭐ 省略 at：schema 放行，落进用户视野', async () => {
    _resetViewpoints();
    setViewpoint(pid, { camera: { x: 70000, y: 70000, w: 1400, h: 900 }, zoom: 1 });
    const args = parse({ ops: [{ op: 'add_node', id: 'free', text: '不给位置' }] });
    const r = await edit(args);
    expect(r.isError, r.content[0].text).toBeUndefined();
    const [, e] = Object.entries((await readBoard(pid)).objects).find(([, o]) => o.data?.lid === 'free');
    expect(e.x).toBeGreaterThanOrEqual(70000);
    expect(e.y).toBeGreaterThanOrEqual(70000);
    expect(e.x + e.w).toBeLessThanOrEqual(71400);
    _resetViewpoints();
  });

  it('⭐ gap / x,y / dx,dy：报「只收关系」，不是 Unrecognized key', () => {
    for (const to of [{ by: 'a', side: 'right', gap: 40 }, { x: 1, y: 2 }, { dx: -120, dy: 0 }]) {
      let msg = '';
      try { parse({ ops: [{ op: 'move', id: 'a', to }] }); } catch (err) { msg = String(err?.message || err); }
      expect(msg, JSON.stringify(to)).toContain('只收关系');
      expect(msg).not.toContain('Unrecognized key');
    }
    let msg = '';
    try { parse({ ops: [{ op: 'add_node', text: 't', at: { by: 'a', gap: 8 } }] }); } catch (err) { msg = String(err?.message || err); }
    expect(msg).toContain('收到了：gap');
    // 其它未知键照旧由 strictObject 拒
    expect(() => parse({ ops: [{ op: 'move', id: 'a', to: { by: 'a', foo: 1 } }] })).toThrow();
  });
});

describe('A 救援入座按入座器实际落的 id 回查（iss_mt9cmke6_pset，走真入座器）', () => {
  it('⭐ near 指向还没座位的单页站 / 散放 docx / 站点入口：第一次调用就成，不报「磁盘上也没有」', async () => {
    await put('_drafts/试作.html', '<html><body>t</body></html>');
    await put('简历v9.docx', 'PKfake');
    await put('新站/index.html', '<html><body>n</body></html>');
    for (const [near, want] of [['_drafts/试作.html', 'site:_drafts/试作.html'], ['简历v9.docx', 'docx:简历v9.docx'], ['新站/index.html', 'site:新站']]) {
      const r = await write({ text: `评 ${near}`, near });
      expect(r.isError, `${near}: ${r.content[0].text}`).toBeUndefined();
      const board = await readBoard(pid);
      expect(Number.isFinite(board.objects[want]?.x), want).toBe(true);
      expect(Object.values(board.bindings).some((b) => b.type === 'annotates' && b.to === want), want).toBe(true);
    }
    expect((await readBoard(pid)).zones['新站']).toBeUndefined();   // 站点目录没长出隐形文件夹层
  });

  it('真不存在的：说「磁盘上也没有」；不上画布的位置：不这么说', async () => {
    const miss = await write({ text: 'x', near: '根本没有.html' });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain('磁盘上也没有');
    const hidden = await write({ text: 'x', near: 'exports/交付.zip' });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).not.toContain('磁盘上也没有');
  });
});
