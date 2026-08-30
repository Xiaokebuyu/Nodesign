/**
 * 2026-08-30 这一批修缮的反向断言。每条都先造一个「改回去就会红」的局面。
 *
 * 来历：全库 358 份 agent 转录 + 生产/exp 两个问题库交叉扫出来的。四条各自的实证：
 *   ① #tag 锚点：我们在工具描述里明写支持，查询侧从来没剥过 # —— 全库 5 次用、5 次全废，
 *      不带 # 的 2773 次全通。
 *   ② follow 目标还不存在：skill 教的顺序（开场立规则 → 再写第一章）跟代码要求正好反着，
 *      全库 5 次、跨 4 个项目，形态一模一样。
 *   ③ 文件夹没有手：agent 从来没有过摆文件夹的办法（zones 不在 objects 里，move 查不到）。
 *   ④「最新那张纸」两套算法：落位按 at 取，状态块按 y 取数组末项。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-0830-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { bareTag, tagEnvelope } = await import('./canvas-id.js');
const { latestSheetId, currentSheet } = await import('./board-sheets.js');
const { applyFollows } = await import('./board-follow.js');
const { readBoard, patchBoard } = await import('../projects/board-store.js');
const { ensureProjectWorkspace } = await import('../projects/workspace.js');
const { makeEditBoardTool } = await import('../engine/mcp/tools/edit-board.js');

const sizeOf = () => ({ w: 100, h: 50 });

describe('① #tag 查询侧统一剥井号', () => {
  const board = { objects: { 'text:a': { x: 10, y: 10, tag: '状态板' } } };
  it('⭐ 带 # / 不带 # / 多个 # / 前后空格，都指向同一组', () => {
    for (const q of ['状态板', '#状态板', '##状态板', '  #状态板 ']) {
      expect(tagEnvelope(board, q, sizeOf), q).toMatchObject({ anchorId: 'text:a' });
    }
  });
  it('对照：不存在的 tag 还是 null（不是"什么都认"）', () => {
    expect(tagEnvelope(board, '#不存在', sizeOf)).toBeNull();
    expect(tagEnvelope(board, '#', sizeOf)).toBeNull();
    expect(tagEnvelope(board, '', sizeOf)).toBeNull();
  });
  it('bareTag 只剥前导 #，中间的井号是名字的一部分', () => {
    expect(bareTag('#a#b')).toBe('a#b');
  });
});

describe('④ 「最新那张纸」只有一套算法', () => {
  // 这块板刻意让"按 at 最新"和"按 y 最下"分叉：p2 是新开的，但铺在 p1 上方
  // （open_sheet{where:'viewport'} 在用户往上滚之后就是这个形状）
  const board = {
    sheets: {
      p1: { x: 0, y: 1000, w: 800, h: 600, at: '2026-08-30T01:00:00Z' },
      p2: { x: 0, y: 0, w: 800, h: 600, at: '2026-08-30T02:00:00Z' },
    },
  };
  it('⭐⭐ 按登记时间取，不是按 y 取最下面那张', () => {
    expect(latestSheetId(board)).toBe('p2');
    expect(currentSheet(board).id).toBe('p2');
  });
  it('会话钉过的那张优先（钉子还在就认它）', () => {
    expect(currentSheet(board, 'p1').id).toBe('p1');
    expect(currentSheet(board, '早撕了').id).toBe('p2');   // 钉子失效回落到最新
  });
  it('一张纸都没有 → null', () => {
    expect(latestSheetId({ sheets: {} })).toBeNull();
    expect(currentSheet({})).toBeNull();
  });
});

describe('② follow：目标 tag 还不存在时先立规则', () => {
  const pid = 'proj_follow_defer';
  let edit;
  beforeAll(async () => {
    await ensureProjectWorkspace(pid);
    edit = (a) => makeEditBoardTool({ projectId: pid, sharedRoot: tmp, sessionId: 's', ctx: { emit() {} } }).handler(a, {});
    // 只有状态板，一件「章节」都没有 —— 这正是 skill 教的开场顺序
    await patchBoard(pid, { objects: {
      'text:pc': { x: 100, y: 100, w: 200, h: 80, tag: '状态板', by: 'agent', seat: 'agent', zone: '' },
    } });
  });

  it('⭐⭐ 目标空着不再报错，规则落进 board.follows', async () => {
    const r = await edit({ ops: [{ op: 'follow', group_tag: '状态板', target_tag: '章节', side: 'right' }] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('规则立好了');
    expect((await readBoard(pid)).follows).toEqual({ 状态板: { target: '章节', side: 'right' } });
  });

  it('⭐⭐ 第一件带该 tag 的东西一落，线自动接上、组挪到它旁边', async () => {
    await patchBoard(pid, { objects: {
      'notes/板书/第一章.md': { x: 600, y: 400, w: 400, h: 200, tag: '章节', by: 'agent', seat: 'agent', zone: '' },
    } });
    await applyFollows(pid, { tag: '章节', newId: 'notes/板书/第一章.md' });
    const b = await readBoard(pid);
    const line = Object.values(b.bindings).find((x) => x.follow === '章节');
    expect(line, '规则没兑现成线').toBeTruthy();
    expect(line.to).toBe('notes/板书/第一章.md');
    // 组真的被挪到目标右侧了（不是只连了根线还留在原地）
    expect(b.objects['text:pc'].x).toBeGreaterThan(600);
  });

  it('⭐ #号写法一样认（两条修缮叠在一起也要成立）', async () => {
    const p2 = 'proj_follow_hash';
    await ensureProjectWorkspace(p2);
    const e2 = (a) => makeEditBoardTool({ projectId: p2, sharedRoot: tmp, sessionId: 's', ctx: { emit() {} } }).handler(a, {});
    await patchBoard(p2, { objects: { 'text:x': { x: 0, y: 0, w: 100, h: 50, tag: '立绘', by: 'agent', seat: 'agent', zone: '' } } });
    const r = await e2({ ops: [{ op: 'follow', group_tag: '#立绘', target_tag: '#正章' }] });
    expect(r.isError).toBeFalsy();
    expect((await readBoard(p2)).follows).toEqual({ 立绘: { target: '正章' } });
  });

  it('unfollow 连规则一起撤 —— 只删线的话下一件落下来它又长回来', async () => {
    const r = await edit({ ops: [{ op: 'unfollow', group_tag: '状态板' }] });
    expect(r.isError).toBeFalsy();
    expect((await readBoard(pid)).follows).toBeUndefined();
  });
});

describe('③ 文件夹卡进摆位系统', () => {
  const pid = 'proj_folder_move';
  let edit;
  beforeAll(async () => {
    await ensureProjectWorkspace(pid);
    edit = (a) => makeEditBoardTool({ projectId: pid, sharedRoot: tmp, sessionId: 's', ctx: { emit() {} } }).handler(a, {});
    await patchBoard(pid, {
      zones: { 素材: { x: 10, y: 10 } },
      sheets: { p1: { x: 0, y: 0, w: 1200, h: 900, at: '2026-08-30T01:00:00Z', by: 'agent' } },
    });
  });

  it('⭐⭐ move 认文件夹 id，落到纸内坐标（在此之前一律报"不在板上"）', async () => {
    const r = await edit({ ops: [{ op: 'move', id: '素材', to: { x: 300, y: 200 } }] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('move 文件夹');
    // 纸内 (300,200) + 版心边距 24 = 世界 (324,224)
    expect((await readBoard(pid)).zones.素材).toEqual({ x: 324, y: 224 });
  });

  it('⭐ 位移写法也认', async () => {
    await edit({ ops: [{ op: 'move', id: '素材', to: { dx: 10, dy: -4 } }] });
    expect((await readBoard(pid)).zones.素材).toEqual({ x: 334, y: 220 });
  });

  it('对照：不存在的文件夹还是报不在板上（断言不是恒真的）', async () => {
    const r = await edit({ ops: [{ op: 'move', id: '没这个文件夹', to: { x: 0, y: 0 } }] });
    expect(r.isError).toBeTruthy();
    expect(r.content[0].text).toContain('不在板上');
  });
});
