/**
 * 谱系收叠进服务端（09-17）：前端早就把改自链的旧版叠到现役版身后（⧉N），
 * 服务端此前不知道 —— read_board 照列、锚点能落到看不见的卡旁边、主角判断把旧版也算进去。
 * 这里钉住五个入口跟前端同口径：read_board / 锚点解析 / edit_board 的 to.by / pin_to_board 的提示 / 主角。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-lineage-stack-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeReadBoardTool } = await import('./read-board.js');
const { makeEditBoardTool } = await import('./edit-board.js');
const { makePinToBoardTool } = await import('./pin-to-board.js');
const { patchBoard, readBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getSharedDir } = await import('../../../projects/workspace.js');
const { makeAnchorResolver } = await import('../../../lib/board-anchor.js');
const { boardHeroId } = await import('../../../lib/board-hero.js');

const pid = 'proj_lineage_stack';
const card = (x, y) => ({ x, y, w: 200, h: 176 });
const df = (from, to) => ({ type: 'derives-from', from, to, by: 'agent' });
let root; let read; let edit;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  root = getSharedDir(pid);
  for (const f of ['logo-v1.png', 'logo-v2.png', 'logo-v3.png', 'other.png']) await fs.writeFile(path.join(root, f), 'x');
  read = (args = {}) => makeReadBoardTool({ projectId: pid, sharedRoot: root }).handler(args, {});
  edit = (args) => makeEditBoardTool({ projectId: pid, sharedRoot: root, ctx: { emit: () => {} } }).handler(args, {});
  await patchBoard(pid, {
    objects: {
      'logo-v1.png': card(0, 0), 'logo-v2.png': card(0, 400), 'logo-v3.png': card(0, 800),
      'other.png': card(2000, 0),
    },
    bindings: { b1: df('logo-v2.png', 'logo-v1.png'), b2: df('logo-v3.png', 'logo-v2.png') },
  });
});

describe('read_board', () => {
  it('根层不逐件列叠住的旧版，现役版那行点名身后有谁', async () => {
    const text = (await read()).content[0].text;
    expect(text).toMatch(/logo-v3\.png[^\n]*〔身后叠着 2 个旧版：logo-v2\.png、logo-v1\.png〕/);
    expect(text).not.toMatch(/^- (\S+ )?logo-v1\.png/m);
    expect(text).not.toMatch(/^- (\S+ )?logo-v2\.png/m);
    expect(text).toMatch(/^- (\S+ )?other\.png/m);
  });
});

describe('read_board 标「历史 N 版」（刀二）', () => {
  it('改写过的板书在大纲里标版本数，没改过的不标', async () => {
    const { rewriteChalkBody } = await import('../../../lib/chalk-rewrite.js');
    const { renderChalk } = await import('../../../lib/chalk.js');
    const dir = path.join(root, 'notes', '板书');
    await fs.mkdir(dir, { recursive: true });
    const one = path.join(dir, '改过的.md'); const two = path.join(dir, '没改过的.md');
    await fs.writeFile(one, renderChalk({ body: '第一版', by: 'agent' }));
    await fs.writeFile(two, renderChalk({ body: '只写过一次', by: 'agent' }));
    await rewriteChalkBody(one, '第二版', { w: 432 });
    await rewriteChalkBody(one, '第三版', { w: 432 });
    await patchBoard(pid, { objects: { 'notes/板书/改过的.md': card(3000, 0), 'notes/板书/没改过的.md': card(3000, 400) } });
    const text = (await read()).content[0].text;
    expect(text).toMatch(/「第三版」[^\n]*〔历史 2 版〕/);
    expect(text).toMatch(/「只写过一次」(?![^\n]*历史)/);
  });
});

describe('锚点解析', () => {
  const resolver = () => makeAnchorResolver({
    projectId: pid, known: new Set(), readBoard, seatArtifacts: async () => ({ seated: 0 }),
  });

  it('点名叠住的旧版 → 锚到身前那张，并如实报', async () => {
    const b = await readBoard(pid);
    const a = await resolver()('logo-v1.png', b);
    expect(a.anchorId).toBe('logo-v3.png');
    expect(a.rect).toMatchObject({ x: 0, y: 800 });
    expect(a.fuzzy.how).toContain('叠在 logo-v3.png 身后的旧版');
  });

  it('宽认：三个版本都含「logo」，叠起来只算一张 → 唯一命中现役版', async () => {
    const b = await readBoard(pid);
    const a = await resolver()('logo', b);
    expect(a?.anchorId).toBe('logo-v3.png');
  });
});

describe('edit_board move 的 to.by', () => {
  it('参照是叠住的旧版 → 按现役版的位置落，返回里说明', async () => {
    const res = await edit({ ops: [{ op: 'move', id: 'other.png', to: { by: 'logo-v1.png', side: 'right' } }] });
    const text = res.content[0].text;
    expect(res.isError).toBeFalsy();
    expect(text).toContain('logo-v3.png');
    const o = (await readBoard(pid)).objects['other.png'];
    expect(o.y).toBeGreaterThanOrEqual(800 - 176);   // 贴着 v3（y=800），不是 v1（y=0）
  });
});

describe('改写即归档用户标注（刀四）', () => {
  it('⭐ agent 改写板书 → 用户的蓝字标注和线一起撤掉，原文进 .history，返回里说明', async () => {
    const { renderChalk } = await import('../../../lib/chalk.js');
    const { historyPathFor } = await import('../../../lib/chalk-history.js');
    const dir = path.join(root, 'notes', '板书');
    await fs.mkdir(dir, { recursive: true });
    const rel = 'notes/板书/配色.md';
    await fs.writeFile(path.join(dir, '配色.md'), renderChalk({ body: '先按暖褐走', by: 'agent' }));
    await patchBoard(pid, {
      objects: { [rel]: card(5000, 0), 'text:u9': { x: 5500, y: 0, w: 200, h: 60, kind: 'text', data: { t: '换成冷灰试试' } } },
      bindings: { bu9: { type: 'annotates', from: 'text:u9', to: rel, by: 'user' } },
    });
    const res = await edit({ ops: [{ op: 'set_text', id: rel, text: '改成冷灰，理由是照片偏冷' }] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('1 条标注已随旧正文归档');
    const after = await readBoard(pid);
    expect(after.objects['text:u9']).toBeUndefined();
    expect(after.bindings.bu9).toBeUndefined();
    const hist = await fs.readFile(historyPathFor(path.join(dir, '配色.md')), 'utf8');
    expect(hist).toContain('先按暖褐走');
    expect(hist).toContain('> 用户当时标注：换成冷灰试试');
  });
});

describe('pin_to_board', () => {
  it('钉的是叠住的旧版 → 返回说明它仍在现役版身后、要点开才看得见', async () => {
    const pin = makePinToBoardTool({ projectId: pid, sharedRoot: root, ctx: { emit: () => {} } });
    const res = await pin.handler({ path: 'logo-v1.png', place: { by: 'other.png', side: 'right' } }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('stacked behind logo-v3.png');
  });
});

describe('让路（agent 路权）', () => {
  it('⭐ 点名「放到 X 右边」→ 就落在右边，挡路的挪开，返回点名挪了谁', async () => {
    // ⚠️ 障碍集会剔掉磁盘上已不存在的座位（seatBacked），夹具必须真写文件，否则挡路的那张根本不算障碍
    for (const f of ['锚.png', '挡路.png', '被挤的.png']) await fs.writeFile(path.join(root, f), 'x');
    await patchBoard(pid, { objects: { '锚.png': card(8000, 0), '挡路.png': card(8240, 0), '被挤的.png': card(9000, 3000) } });
    const res = await edit({ ops: [{ op: 'move', id: '被挤的.png', to: { by: '锚.png', side: 'right' } }] });
    expect(res.isError).toBeFalsy();
    const after = await readBoard(pid);
    // 落在锚的右边（锚宽 200，间距一格）
    expect(after.objects['被挤的.png'].x).toBeGreaterThanOrEqual(8200);
    expect(after.objects['被挤的.png'].y).toBe(0);
    // 原来占着那块地的被挪开了（方向取位移最小的那一个，所以只断言「不再重叠」）
    const a = after.objects['被挤的.png']; const b = after.objects['挡路.png'];
    const apart = (b.x + 200 <= a.x) || (a.x + 200 <= b.x) || (b.y + 176 <= a.y) || (a.y + 176 <= b.y);
    expect(apart, `挡路.png 还压在 (${a.x},${a.y}) 上：(${b.x},${b.y})`).toBe(true);
    expect(b.x !== 8240 || b.y !== 0).toBe(true);
    expect(res.content[0].text).toContain('挪开了');
  });
});

describe('主角判断', () => {
  it('叠住的旧版不参与：唯一的站点是旧版、现役版是图片 → 没有主角（前端同样没有）', () => {
    const board = {
      zones: {},
      objects: { 'site:旧站': card(0, 0), '新图.png': card(0, 400) },
      bindings: { b: df('新图.png', 'site:旧站') },
    };
    expect(boardHeroId(board)).toBeNull();
    const plain = { ...board, bindings: {} };
    expect(boardHeroId(plain)).toBe('site:旧站');
  });
});
