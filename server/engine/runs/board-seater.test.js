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
    expect(seatable('/etc/passwd')).toBe(false);
    expect(seatable('a/../b.md')).toBe(false);
  });

  it('seatable 跟画布扫描面同一形状（09-07）：渲染的才有座位，不渲染的不占座', () => {
    // 渲染成卡的
    expect(seatable('_drafts/试作.html')).toBe(true);        // 根上的单页是正式产物
    expect(seatable('assets/photo.jpg')).toBe(true);          // assets 顶层
    expect(seatable('assets/notes/a.md')).toBe(true);
    expect(seatable('notes/灵感.md')).toBe(true);
    expect(seatable('notes/板书/x.md')).toBe(true);
    expect(seatable('参考图/ref-abc.jpg')).toBe(true);        // 搜图落根上的真文件夹
    // 不渲染的：有座位等于 read_board 里一堆用户看不见的东西
    expect(seatable('_drafts/deep/x.html')).toBe(false);
    expect(seatable('站点/_drafts/x.html')).toBe(false);
    expect(seatable('assets/references/ref-abc.jpg')).toBe(false);
    expect(seatable('assets/references/web/site/a.palette.json')).toBe(false);
    expect(seatable('assets/generated/.thumbnails/a.thumb.webp')).toBe(false);
    expect(seatable('exports/handoff-1.zip')).toBe(false);
    expect(seatable('notes/深/一层.md')).toBe(false);
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

  it('文件夹站按注册表入座成 site:<夹>（09-07 站点卡没有碰撞面积案）：一张卡、桌面层、多文件只排一次', async () => {
    await fs.mkdir(path.join(root, '第二站'), { recursive: true });
    await fs.writeFile(path.join(root, '第二站/index.html'), '<!doctype html><html><body><h1>二</h1></body></html>', 'utf8');
    await fs.writeFile(path.join(root, '第二站/style.css'), 'body{}', 'utf8');
    const { seated } = await seatArtifacts(pid, ['第二站/index.html', '第二站/style.css']);
    expect(seated).toBe(1);
    const board = await readBoard(pid);
    expect(board.objects['deck:第二站/index.html']).toBeUndefined();   // 以前排的是这个幻影
    const e = board.objects['site:第二站'];
    expect(e).toBeTruthy();
    expect(e.zone ?? '').toBe('');
    expect(e.w).toBe(640);
    // 09-17 iss_mtp465ds_ctko：站点目录不建文件夹坐标（前端不画那层，锚点解析却先认它）
    expect(board.zones['第二站']).toBeUndefined();
    expect(board.zones['小说']).toBeTruthy();   // 真文件夹照建
    // 它现在是障碍：下一件东西不会压在它身上
    await fs.writeFile(path.join(root, '再来一张.png'), Buffer.alloc(10), 'utf8');
    await seatArtifacts(pid, ['再来一张.png']);
    const img = (await readBoard(pid)).objects['再来一张.png'];
    const overlap = !(img.x + 200 <= e.x || img.x >= e.x + e.w || img.y + 176 <= e.y || img.y >= e.y + e.h);
    expect(overlap).toBe(false);
  });

  it('09-14 问题库：资源先到按裸路径入座，index.html 后到坐下站点卡时把它们收编掉', async () => {
    await fs.mkdir(path.join(root, '全景'), { recursive: true });
    await fs.writeFile(path.join(root, '全景/data.js'), 'export default 1', 'utf8');
    await fs.writeFile(path.join(root, '全景/sheet.css'), 'body{}', 'utf8');
    await seatArtifacts(pid, ['全景/data.js']);
    await seatArtifacts(pid, ['全景/sheet.css']);
    let board = await readBoard(pid);
    expect(board.objects['全景/data.js']).toBeTruthy();        // 当时还不是站：裸座位是合法的
    await fs.writeFile(path.join(root, '全景/index.html'), '<!doctype html><h1>全景</h1>', 'utf8');
    const r = await seatArtifacts(pid, ['全景/index.html']);
    expect(r.absorbed).toBe(2);
    board = await readBoard(pid);
    expect(board.objects['site:全景']).toBeTruthy();
    expect(board.objects['全景/data.js']).toBeUndefined();
    expect(board.objects['全景/sheet.css']).toBeUndefined();
    await fs.access(path.join(root, '全景/data.js'));           // 文件不动
    // 别的目录里的散件不受牵连
    expect(board.objects['小说/第一章.md']).toBeTruthy();
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

describe('临时座重解（2026-09-05：前端 packRow 抢先排的座只是"先别闪"）', () => {
  it('⭐ provisional 且 seat:auto 的座被服务端按障碍重解并清标；用户拖过的不动', async () => {
    const pid2 = 'proj_seater_provisional';
    await ensureProjectWorkspace(pid2);
    const root2 = getSharedDir(pid2);
    await fs.mkdir(path.join(root2, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root2, 'assets/新图.png'), 'x');
    await fs.writeFile(path.join(root2, 'assets/用户摆的.png'), 'x');
    await fs.mkdir(path.join(root2, '稿'), { recursive: true });
    await fs.writeFile(path.join(root2, '稿/index.html'), '<html></html>');   // 座位要有文件本体才算障碍
    // 桌面上已有一张 deck 占着 (24,0)-(664,388)；前端把新图临时排在了它身上
    await patchBoard(pid2, { objects: {
      'deck:稿/index.html': { x: 24, y: 0, w: 640, h: 388, seat: 'auto' },
      'assets/新图.png': { x: 48, y: 40, seat: 'auto', provisional: true },
      'assets/用户摆的.png': { x: 60, y: 60, seat: 'user', provisional: true },
    } });
    const before = await readBoard(pid2);
    expect(before.objects['assets/新图.png'].provisional).toBe(true);
    expect(before.objects['assets/用户摆的.png'].provisional).toBeUndefined();   // sanitizer：user 座不临时
    const r = await seatArtifacts(pid2, ['assets/新图.png', 'assets/用户摆的.png']);
    expect(r.seated).toBe(1);
    const b = await readBoard(pid2);
    const e = b.objects['assets/新图.png'];
    expect(e.provisional).toBeUndefined();
    const deck = { x: 24, y: 0, w: 640, h: 388 };
    const overlap = !(e.x + e.w <= deck.x || deck.x + deck.w <= e.x || e.y + e.h <= deck.y || deck.y + deck.h <= e.y);
    expect(overlap).toBe(false);
    expect(b.objects['assets/用户摆的.png']).toMatchObject({ x: 60, y: 60, seat: 'user' });
  });
});

/**
 * 09-17（iss_mt9cmke6_pset）：入座器回报点名路径落在哪张卡上 —— 救援入座按这个 id 回查。
 * 以及两条跟着查出来的：普通目录不当文件卡坐；子文件夹里的产物 id 不丢文件夹前缀。
 */
describe('入座回报 ids / missing / skipped（09-17）', () => {
  it('⭐ 点名路径 → 实际落座的卡 id（站点 / 单页站 / 散放 docx / 子文件夹 deck / 本来就有座位的站点成员）', async () => {
    const pid3 = 'proj_seater_ids';
    await ensureProjectWorkspace(pid3);
    const r3 = getSharedDir(pid3);
    const put = async (rel, body = 'x') => { await fs.mkdir(path.dirname(path.join(r3, rel)), { recursive: true }); await fs.writeFile(path.join(r3, rel), body); };
    await put('官网/index.html', '<html><body>x</body></html>');
    await put('官网/style.css', 'a{}');
    await put('_drafts/首发.html', '<html><body>y</body></html>');
    await put('报告v2.docx', 'PKfake');
    await put('小说/插页.html', '<html><body>z</body></html>');
    const r = await seatArtifacts(pid3, ['官网/index.html', '_drafts/首发.html', '报告v2.docx', '小说/插页.html', '没了.md', 'exports/x.zip']);
    expect(r.ids).toEqual({
      '官网/index.html': 'site:官网',
      '_drafts/首发.html': 'site:_drafts/首发.html',
      '报告v2.docx': 'docx:报告v2.docx',
      '小说/插页.html': 'deck:小说/插页.html',
    });
    expect(r.missing).toEqual(['没了.md']);
    expect(r.skipped).toEqual(['exports/x.zip']);
    const board = await readBoard(pid3);
    for (const id of Object.values(r.ids)) expect(Number.isFinite(board.objects[id]?.x), id).toBe(true);
    expect(board.objects['deck:插页.html']).toBeUndefined();   // 子文件夹 deck 曾被拼成根上的幽灵
    // 站点成员：卡本来就有座位（seated=0）也回报
    const again = await seatArtifacts(pid3, ['官网/style.css']);
    expect(again.seated).toBe(0);
    expect(again.ids).toEqual({ '官网/style.css': 'site:官网' });
  });

  it('⭐ 普通目录不当文件卡坐（前端画的是文件夹卡），回报 skipped', async () => {
    const pid4 = 'proj_seater_dir';
    await ensureProjectWorkspace(pid4);
    await fs.mkdir(path.join(getSharedDir(pid4), '素材夹'), { recursive: true });
    const r = await seatArtifacts(pid4, ['素材夹']);
    expect(r.seated).toBe(0);
    expect(r.skipped).toEqual(['素材夹']);
    expect((await readBoard(pid4)).objects['素材夹']).toBeUndefined();
  });
});
