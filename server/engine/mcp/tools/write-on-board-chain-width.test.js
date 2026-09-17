/**
 * 接楼继承宽度（09-17，问题库 iss_mthb946a_ieyw）。
 *
 * chain / reply_to 落在上一条正下方，但宽度原来按正文估或按用户偏好取：600 宽的父卡下面
 * 接出 432 宽的子卡。修法在 write-on-board-resolve.js 的 resolveChalkSpot：接楼且没点名
 * width 时按被接那条的宽取格数；点名了照旧优先。流式预解算走同一个函数，一并钉住。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-wob-chainw-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeWriteOnBoardTool, makePreviewer } = await import('./write-on-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');
const { _resetReservations } = await import('../../../lib/board-reservations.js');

const pid = 'proj_wob_chain_width';
let sharedRoot; let call; let previewer;
let seq = 0;

/** 按正文找那条板书的落盘条目 */
async function entryByText(text) {
  const b = await readBoard(pid);
  for (const [id, e] of Object.entries(b.objects)) {
    if (!id.startsWith('notes/板书/')) continue;
    try { if ((await fs.readFile(path.join(sharedRoot, id), 'utf8')).includes(text)) return e; } catch { /* */ }
  }
  return null;
}

/** 摆一条父板书（每个用例一条新线，互不干扰） */
async function seedParent({ w, tag, x = 5000, extra = {} }) {
  seq += 1;
  const id = `notes/板书/cw-${String(seq).padStart(4, '0')}-父.md`;
  await fs.mkdir(path.join(sharedRoot, 'notes/板书'), { recursive: true });
  await fs.writeFile(path.join(sharedRoot, id), '---\nnd: chalk\n---\n父卡正文\n', 'utf8');
  await patchBoard(pid, { objects: { [id]: { x: x + seq * 2000, y: 5000, h: 200, by: 'agent', tag, seat: 'agent', ...(w ? { w } : {}), ...extra } } });
  return id;
}

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
  const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot, sessionId: 's1', ctx: { emit: () => {} } });
  call = (args) => t.handler(args);
  previewer = makePreviewer({ projectId: pid, sharedRoot });
});

beforeEach(() => {
  _resetViewpoints(); _resetReservations();
  setViewpoint(pid, { camera: { x: 0, y: 0, w: 1600, h: 1000 }, layer: '' });
});

describe('接楼继承上一条的宽度', () => {
  it('⭐ chain:true 且没给 width：600 宽的父卡接出 600 宽的子卡（原来是 432）', async () => {
    await seedParent({ w: 600, tag: '宽线甲' });
    // 正文足够长，按正文估会落到 18 格 = 432（问题库那一例的形状）
    const r = await call({ text: '接着上一条往下写，这一段话写得比较长，按正文估宽会落到四百三十二像素那一档上', tag: '宽线甲', chain: true });
    expect(r.isError).toBeUndefined();
    expect((await entryByText('接着上一条往下写')).w).toBe(600);
  });

  it('⭐ reply_to 且没给 width：同样沿用被接那条的宽', async () => {
    const parent = await seedParent({ w: 480, tag: '宽线乙' });
    const r = await call({ text: '回应上一条：短话', reply_to: parent });
    expect(r.isError).toBeUndefined();
    expect((await entryByText('回应上一条：短话')).w).toBe(480);
  });

  it('⭐ 显式给了 width 照旧优先（narrow = 10 格 = 240）', async () => {
    await seedParent({ w: 600, tag: '宽线丙' });
    const r = await call({ text: '点名要窄的一条', tag: '宽线丙', chain: true, width: 'narrow' });
    expect(r.isError).toBeUndefined();
    expect((await entryByText('点名要窄的一条')).w).toBe(240);
  });

  it('继承压过用户偏好（sized:user 学到的宽）：一条线的版心以线为准', async () => {
    // 板上最近三块用户亲手调过的板书都是 20 格（480）
    await patchBoard(pid, { objects: Object.fromEntries([1, 2, 3].map(i => [
      `notes/板书/zz-pref-${i}.md`, { x: 90000 + i * 600, y: 90000, w: 480, h: 100, sized: 'user', by: 'agent' },
    ])) });
    await seedParent({ w: 720, tag: '宽线丁' });
    const r = await call({ text: '偏好与继承谁先', tag: '宽线丁', chain: true });
    expect(r.isError).toBeUndefined();
    expect((await entryByText('偏好与继承谁先')).w).toBe(720);
    // 不接楼的话仍然按偏好取（继承不外溢）
    const r2 = await call({ text: '不接楼的一条' });
    expect(r2.isError).toBeUndefined();
    expect((await entryByText('不接楼的一条')).w).toBe(480);
  });

  it('非整格的宽取最近的格数；极端宽夹到 60 格', async () => {
    await seedParent({ w: 610, tag: '宽线戊' });
    await call({ text: '六百一的下一条', tag: '宽线戊', chain: true });
    expect((await entryByText('六百一的下一条')).w).toBe(600);   // round(610/24)=25 → 600
    await seedParent({ w: 3000, tag: '宽线己' });
    await call({ text: '三千宽的下一条', tag: '宽线己', chain: true });
    expect((await entryByText('三千宽的下一条')).w).toBe(60 * 24);
  });

  it('父卡没有落盘宽度（老条目）→ 不拿估算冒充，照旧按正文估', async () => {
    await seedParent({ w: null, tag: '宽线庚' });
    // 无 w 的板书估出来是 note 身位（200 宽）；若拿它冒充就会落成 8 格 = 192
    await call({ text: '老条目下的接楼', tag: '宽线庚', chain: true });
    await call({ text: '老条目对照组' });
    const chained = await entryByText('老条目下的接楼');
    const plain = await entryByText('老条目对照组');
    expect(chained.w).toBe(plain.w);
    expect(chained.w).not.toBe(192);
  });

  it('reply_to 指到不是板书的东西（图片卡）→ 不继承那张卡的宽', async () => {
    await patchBoard(pid, { objects: { 'assets/宽图.png': { x: 70000, y: 70000, w: 900, h: 300 } } });
    await call({ text: '挂在图下的一条', reply_to: 'assets/宽图.png' });
    await call({ text: '图下对照组' });
    expect((await entryByText('挂在图下的一条')).w).toBe((await entryByText('图下对照组')).w);
  });

  it('⭐ 流式预解算走同一套：预告的框宽 = 父卡宽', async () => {
    await seedParent({ w: 552, tag: '宽线辛' });
    const solved = await previewer.solve({ tag: '宽线辛', chain: true, text: '流式到达的正文' }, 'toolu_cw1');
    expect(solved).toBeTruthy();
    expect(solved.w).toBe(552);
  });

  it('手机竖列视点下仍受一屏宽封顶（继承不越过车道上限）', async () => {
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 390, h: 800 }, layer: '', device: { class: 'phone', w: 390, h: 800 } });
    await seedParent({ w: 720, tag: '宽线壬' });
    const solved = await previewer.solve({ tag: '宽线壬', chain: true, text: '手机上的接楼' }, 'toolu_cw2');
    expect(solved).toBeTruthy();
    expect(solved.w).toBeLessThan(720);
  });
});
