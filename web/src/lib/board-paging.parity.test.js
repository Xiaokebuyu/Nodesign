/**
 * 摞的结构：前端那份 == 服务端那份（2026-09-01 叠纸）。
 *
 * ⚠️ 比的是**行为不是常量**（08-30 board-kind-sizes.parity 栽过：两边都写 148，
 * 而屏幕上是 369）。所以拿一批真实形状的板逐块跑两份实现，比摞的划分、顺序、
 * 原点和宽高。
 *
 * 前端为什么必须有一份：显示到第几页是看的人自己的事，不进 board.json，所以
 * 翻页这一半只能在前端算；而它要用的"一摞里有哪些纸"必须跟服务端算占位那份
 * 一模一样，否则会出现"屏幕上没有、可服务端说那儿占着地方"。
 */
import { describe, it, expect } from 'vitest';
import { pilesOf, hiddenByPaging, displayedPage, flipTo, neighborPile } from './board-paging.js';
import { stacksOf, neighborStack } from '../../../server/lib/board-stacks.js';

/** 几块形状不同的真实板：一摞两页 + 隐式单张 + 存量竖排 + 空板 */
const BOARDS = [
  {
    name: '一摞两页，旁边一张状态表',
    sheets: {
      p1: { x: 0, y: 0, w: 800, h: 600, at: '01', stack: 'main', title: '第一拍' },
      p2: { x: 0, y: 0, w: 900, h: 640, at: '02', stack: 'main', title: '第二拍' },
      st: { x: 1000, y: 0, w: 360, h: 240, at: '03', title: '状态表' },
    },
    stacks: { main: { title: '主线' } },
  },
  {
    name: '存量竖排（一张 stack 字段都没有）',
    sheets: {
      a: { x: 0, y: 0, w: 2048, h: 973, at: '01' },
      b: { x: 0, y: 1021, w: 2048, h: 973, at: '02' },
      c: { x: 0, y: 2042, w: 2048, h: 480, at: '03' },
    },
    stacks: undefined,
  },
  {
    name: '三摞横排，各自深浅不同',
    sheets: {
      s1: { x: 0, y: 0, w: 400, h: 400, at: '01', stack: 'a' },
      s2: { x: 0, y: 0, w: 400, h: 500, at: '04', stack: 'a' },
      s3: { x: 500, y: 0, w: 400, h: 400, at: '02', stack: 'b' },
      s4: { x: 1000, y: 0, w: 400, h: 400, at: '03', stack: 'c' },
      s5: { x: 1000, y: 0, w: 420, h: 300, at: '05', stack: 'c' },
      s6: { x: 1000, y: 0, w: 380, h: 700, at: '06', stack: 'c' },
    },
    stacks: { a: {}, b: { title: '参考' }, c: { title: '产物' } },
  },
  { name: '空板', sheets: {}, stacks: {} },
];

describe('board-paging 前后端 parity', () => {
  it('摞的划分、顺序、原点、宽高、成员次序逐块一致', () => {
    for (const b of BOARDS) {
      const web = pilesOf(b.sheets, b.stacks);
      const srv = stacksOf({ sheets: b.sheets, stacks: b.stacks });
      expect(web.map(p => p.name), b.name).toEqual(srv.map(p => p.name));
      expect(web.map(p => [p.x, p.y, p.w, p.h]), b.name).toEqual(srv.map(p => [p.x, p.y, p.w, p.h]));
      expect(web.map(p => p.sheets), b.name).toEqual(srv.map(p => p.sheets));
      expect(web.map(p => p.title), b.name).toEqual(srv.map(p => p.title));
      expect(web.map(p => p.implicit), b.name).toEqual(srv.map(p => p.implicit));
    }
  });

  it('左右换摞逐摞一致（含到头的 null）', () => {
    for (const b of BOARDS) {
      const piles = pilesOf(b.sheets, b.stacks);
      const board = { sheets: b.sheets, stacks: b.stacks };
      for (const p of piles) {
        for (const dir of [1, -1]) {
          expect(neighborPile(piles, p.name, dir)?.name ?? null, `${b.name} ${p.name} ${dir}`)
            .toBe(neighborStack(board, p.name, dir)?.name ?? null);
        }
      }
    }
  });
});

describe('翻页与藏页', () => {
  const { sheets, stacks } = BOARDS[0];

  it('缺省显示最新那一页，agent 新开一页会自动跟过去', () => {
    const piles = pilesOf(sheets, stacks);
    const main = piles.find(p => p.name === 'main');
    expect(displayedPage(main, {})).toBe('p2');
    // agent 又叠了一页
    const more = pilesOf({ ...sheets, p3: { x: 0, y: 0, w: 800, h: 600, at: '04', stack: 'main' } }, stacks);
    expect(displayedPage(more.find(p => p.name === 'main'), {})).toBe('p3');
  });

  it('用户翻过之后认他选的那张，直到那张纸没了', () => {
    const main = pilesOf(sheets, stacks).find(p => p.name === 'main');
    expect(displayedPage(main, { main: 'p1' })).toBe('p1');
    expect(displayedPage(main, { main: '撕掉了' })).toBe('p2');
  });

  it('⭐ 藏的只有同一摞里没在显示的那些页；单张摞一张都不藏', () => {
    expect([...hiddenByPaging(sheets, stacks, {})]).toEqual(['p1']);
    expect([...hiddenByPaging(sheets, stacks, { main: 'p1' })]).toEqual(['p2']);
    // st 自己一摞，永远藏不了
    expect([...hiddenByPaging(sheets, stacks, { st: 'st' })]).toEqual(['p1']);
  });

  it('翻到头不循环', () => {
    const main = pilesOf(sheets, stacks).find(p => p.name === 'main');
    expect(flipTo(main, {}, 1)).toBe('p2');         // 已经在最新，翻不动
    expect(flipTo(main, {}, -1)).toBe('p1');
    expect(flipTo(main, { main: 'p1' }, -1)).toBe('p1');
  });
});
