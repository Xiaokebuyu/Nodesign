/**
 * follow 对**所有形态**都成立（2026-08-31 站主：「我期望 agent 可以为所有内容
 * （包括图 站点 docx 等）设置 follow」）。
 *
 * 改之前的答案是「数据层是、触发层不是」：
 *   - tag 只能在**造东西那一刻**给（write_on_board.tag / add_node / 板书 frontmatter），
 *     而图/站点/docx 从来不是 agent 造的 —— 落板时一律没有 tag，而 follow 两端都按
 *     tag 找成员，所以"给图片设 follow"根本无从下手。
 *   - applyFollows 只挂在三处（write_on_board / flow / board-seater），产物走别的路，
 *     永远触发不了跟随。
 *
 * 现在：`edit_board set_tag{ids,tag}` 给任何在板上的东西打标签，pin_to_board 收 tag，
 * 两条路落完都触发 applyFollows。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-follow0831-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeEditBoardTool } = await import('./edit-board.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { _resetViewpoints } = await import('../../../projects/viewpoint-store.js');

const ctx = { emit() {} };
const mk = async (pid) => {
  await ensureProjectWorkspace(pid);
  return { edit: (a) => makeEditBoardTool({ projectId: pid, sharedRoot: getSharedDir(pid), sessionId: `${pid}-s`, ctx }).handler(a, {}) };
};

beforeAll(() => { _resetViewpoints(); });

describe('set_tag：给板上任何东西打标签', () => {
  it('⭐ 图 / 站点 / docx 都能进组（它们从来没有过 tag 的入口）', async () => {
    const pid = 'proj_follow_settag';
    const t = await mk(pid);
    await patchBoard(pid, { objects: {
      'assets/generated/星空.webp': { x: 100, y: 100, w: 320, h: 240 },
      'site:作品集': { x: 500, y: 100, w: 400, h: 300 },
      '报告.docx': { x: 950, y: 100, w: 300, h: 200 },
    } });
    const r = await t.edit({ ops: [{ op: 'set_tag', ids: ['assets/generated/星空.webp', 'site:作品集', '报告.docx'], tag: '素材' }] });
    expect(r.isError).toBeUndefined();
    const b = await readBoard(pid);
    expect(b.objects['assets/generated/星空.webp'].tag).toBe('素材');
    expect(b.objects['site:作品集'].tag).toBe('素材');
    expect(b.objects['报告.docx'].tag).toBe('素材');
  });

  it('#井号照剥（bareTag 那条纪律）；空串去掉标签；不在板上的点名报', async () => {
    const pid = 'proj_follow_settag2';
    const t = await mk(pid);
    await patchBoard(pid, { objects: { 'a.png': { x: 0, y: 0, w: 200, h: 200, tag: '旧' } } });
    const r = await t.edit({ ops: [{ op: 'set_tag', ids: ['a.png', '不存在.png'], tag: '#新' }] });
    expect((await readBoard(pid)).objects['a.png'].tag).toBe('新');
    expect(r.content[0].text).toMatch(/不存在\.png/);
    await t.edit({ ops: [{ op: 'set_tag', ids: ['a.png'], tag: '' }] });
    expect((await readBoard(pid)).objects['a.png'].tag).toBeUndefined();
  });
});

describe('打完标签就触发跟随', () => {
  /**
   * 版面：状态板在 (0,0)，第一张图在 (1000,0)。立规则「#状态板 跟 #图」，
   * 然后给第二张图（在 (1000,600)）打上 #图 —— 状态板应当整组按新旧目标的位移平移。
   */
  it('⭐ set_tag 一张图 → 跟随组当场重指并平移（产物当跟随目标）', async () => {
    const pid = 'proj_follow_img';
    const t = await mk(pid);
    await patchBoard(pid, { objects: {
      'panel.md': { x: 0, y: 0, w: 300, h: 200, tag: '状态板', by: 'agent' },
      'a.png': { x: 1000, y: 0, w: 320, h: 240, tag: '图', by: 'agent' },
      'b.png': { x: 1000, y: 600, w: 320, h: 240, by: 'agent' },
    } });
    // 规则 + 第一条线（follow 走 add 那条：目标已在板上）
    const r1 = await t.edit({ ops: [{ op: 'follow', group_tag: '状态板', target_tag: '图', side: 'right' }] });
    expect(r1.isError).toBeUndefined();
    const afterRule = await readBoard(pid);
    const panelAfterRule = afterRule.objects['panel.md'];

    const r2 = await t.edit({ ops: [{ op: 'set_tag', ids: ['b.png'], tag: '图' }] });
    expect(r2.isError).toBeUndefined();
    const b = await readBoard(pid);
    // 线重指到 b.png
    const link = Object.values(b.bindings).find(x => x.follow === '图');
    expect(link.to).toBe('b.png');
    // ⭐ 平移：位移等于新旧目标的位移（600），**相对位置原样保留**
    expect(b.objects['panel.md'].y - panelAfterRule.y).toBe(600);
    expect(b.objects['panel.md'].x - panelAfterRule.x).toBe(0);
  });

  it('⭐ 平移是纯平行移动 —— agent 自己把跟随组挪开之后，新的相对位置被记住', async () => {
    const pid = 'proj_follow_moved';
    const t = await mk(pid);
    await patchBoard(pid, { objects: {
      'panel.md': { x: 0, y: 0, w: 300, h: 200, tag: '状态板', by: 'agent' },
      'a.png': { x: 1000, y: 0, w: 320, h: 240, tag: '图', by: 'agent' },
      'b.png': { x: 1000, y: 500, w: 320, h: 240, by: 'agent' },
    } });
    await t.edit({ ops: [{ op: 'follow', group_tag: '状态板', target_tag: '图', side: 'right' }] });
    // 撞上了/不好看 → 直接挪（站主原话：「你后面的摆位要是被拦截了可以直接挪动」）
    await t.edit({ ops: [{ op: 'move', id: 'panel.md', to: { dx: -77, dy: 33 } }] });
    const moved = (await readBoard(pid)).objects['panel.md'];

    await t.edit({ ops: [{ op: 'set_tag', ids: ['b.png'], tag: '图' }] });
    const now = (await readBoard(pid)).objects['panel.md'];
    // 手挪出来的那个偏移原样保留，只是整体跟着目标平移了 500
    expect(now.x).toBe(moved.x);
    expect(now.y - moved.y).toBe(500);
  });
});

describe('keep_offset：第一跳也不贴，用现在的相对位置当基线', () => {
  it('⭐ keep_offset:true → 立规则时一件都不动，之后照旧平移', async () => {
    const pid = 'proj_follow_keep';
    const t = await mk(pid);
    await patchBoard(pid, { objects: {
      'panel.md': { x: 40, y: 900, w: 300, h: 200, tag: '状态板', by: 'agent' },
      'a.png': { x: 1000, y: 0, w: 320, h: 240, tag: '图', by: 'agent' },
      'b.png': { x: 1000, y: 700, w: 320, h: 240, by: 'agent' },
    } });
    const r = await t.edit({ ops: [{ op: 'follow', group_tag: '状态板', target_tag: '图', keep_offset: true }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/原地不动/);
    const afterRule = (await readBoard(pid)).objects['panel.md'];
    // ⭐ 一格没动（默认那条会把它贴到 a.png 右边去）
    expect([afterRule.x, afterRule.y]).toEqual([40, 900]);

    await t.edit({ ops: [{ op: 'set_tag', ids: ['b.png'], tag: '图' }] });
    const now = (await readBoard(pid)).objects['panel.md'];
    expect(now.x).toBe(40);
    expect(now.y).toBe(900 + 700);   // 纯平移，距离一点没变
  });

  it('不给 keep_offset → 照旧贴到 side 那一侧（默认行为没动）', async () => {
    const pid = 'proj_follow_snap';
    const t = await mk(pid);
    await patchBoard(pid, { objects: {
      'panel.md': { x: 40, y: 900, w: 300, h: 200, tag: '状态板', by: 'agent' },
      'a.png': { x: 1000, y: 0, w: 320, h: 240, tag: '图', by: 'agent' },
    } });
    await t.edit({ ops: [{ op: 'follow', group_tag: '状态板', target_tag: '图', side: 'right' }] });
    const p = (await readBoard(pid)).objects['panel.md'];
    expect(p.x).toBeGreaterThan(1000);   // 被贴到 a.png 右侧了
  });
});
