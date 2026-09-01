import { describe, it, expect } from 'vitest';
import { slotsOf, resolveSheet, currentSheet } from './board-sheets.js';

/**
 * 册：版式长在摞上，纸只存自己的覆盖（2026-09-01）。
 *
 * ## 这一条翻了 08-30 的一个判决，先说清为什么
 *
 * 08-30 站主否过「翻页继承版面」（原话「每张纸规划一次摆放呗？为什么要继承」）。
 * ⭐ 当时否的**不是继承这个想法，是拿继承去补自动翻页那个洞** —— 机器悄悄翻页、
 * agent 不知道自己换了页，继承只让那个洞不难看。洞后来是用「纸满不翻页、agent
 * 自己开」堵掉的。09-01 三件事都变了：页是 agent 自己开的、页归进了摞、产物地
 * 已经先一步升到了摞。版位升上去是同一个动作的另一半。
 *
 * ## 真板给的量
 *
 * 77 对相邻页里 **18% 的版位 x/y/w 逐字重复**、另有 **12% 名字一样但坐标漂了**，
 * 漂移量中位数只有 40px 而且来回摆 —— 那不是故意换版面，是同一套版面每页重算
 * 一遍算不准。所以继承省掉的不只是打字，是一次算不准的重复推导。
 */
const board = () => ({
  sheets: {
    p1: { x: 0, y: 0, w: 800, h: 600, at: '01', stack: 'main' },
    p2: { x: 0, y: 0, w: 800, h: 600, at: '02', stack: 'main', slots: { main: { x: 0, y: 0, w: 300, h: 200 } } },
    solo: { x: 900, y: 0, w: 400, h: 300, at: '03', slots: { only: { x: 0, y: 0, w: 200, h: 100 } } },
  },
  stacks: {
    main: { slots: { main: { x: 0, y: 0, w: 600, h: 500, about: '正文' }, aside: { x: 620, y: 0, w: 160, h: 500 } } },
  },
});

describe('册：版式两层，按名合并、纸盖摞', () => {
  it('⭐ 什么都不声明的那一页，直接继承整摞的版式', () => {
    expect(slotsOf(board(), 'p1')).toEqual({
      main: { x: 0, y: 0, w: 600, h: 500, about: '正文' },
      aside: { x: 620, y: 0, w: 160, h: 500 },
    });
  });

  it('⭐ 声明过的那一页只覆盖它点名的那一块，别的照旧继承', () => {
    const s = slotsOf(board(), 'p2');
    expect(s.main).toEqual({ x: 0, y: 0, w: 300, h: 200 });   // 这一页自己的
    expect(s.aside).toEqual({ x: 620, y: 0, w: 160, h: 500 });  // 还是摞的
  });

  it('⭐ 改摞的版式，会传到所有没覆盖过它的页 —— 这就是「册」的意义', () => {
    const b = board();
    b.stacks.main.slots.aside = { x: 620, y: 0, w: 200, h: 500 };
    expect(slotsOf(b, 'p1').aside.w, 'p1 没覆盖过 aside，跟着变').toBe(200);
    expect(slotsOf(b, 'p2').aside.w, 'p2 也没覆盖过 aside，跟着变').toBe(200);
    b.stacks.main.slots.main = { x: 0, y: 0, w: 999, h: 500 };
    expect(slotsOf(b, 'p2').main.w, 'p2 覆盖过 main，不跟着变').toBe(300);
  });

  /**
   * ⭐ 这条是攻出来的：第一版测试里「隐式摞名回落纸名」那条守卫**攻了没红**，
   * 因为我的样板里没有「纸没有 stack 字段、版式却登记在同名摞上」这一种。
   *
   * 而那恰恰是**最常见**的形态：第一张纸铺下来时还没有摞的概念，它的 plan 存进
   * `stacks[纸名]`，纸自己一个 stack 字段都没有。回落断了的话，第一张纸和之后
   * 叠上去的每一页都读不到自己的版式。
   */
  it('⭐ 第一张纸：没有 stack 字段，版式登记在同名摞上，照样读得到', () => {
    const b = {
      sheets: {
        p1: { x: 0, y: 0, w: 800, h: 600, at: '01' },
        p2: { x: 0, y: 0, w: 800, h: 600, at: '02', stack: 'p1' },
      },
      stacks: { p1: { slots: { main: { x: 0, y: 0, w: 600, h: 500 } } } },
    };
    expect(slotsOf(b, 'p1').main, '第一张纸读得到自己那一摞的版式').toBeTruthy();
    expect(slotsOf(b, 'p2').main, '叠上去的也读得到').toBeTruthy();
  });

  it('没登记过摞的纸自己就是一摞，行为跟从前一模一样（存量板不受影响）', () => {
    expect(slotsOf(board(), 'solo')).toEqual({ only: { x: 0, y: 0, w: 200, h: 100 } });
    expect(slotsOf({ sheets: { a: { x: 0, y: 0, w: 100, h: 100 } } }, 'a')).toEqual({});
  });

  it('resolveSheet / currentSheet 取出来的纸，slots 已经是合好的那一份', () => {
    expect(resolveSheet(board(), 'p1').slots.aside).toBeTruthy();
    // 会话没指过纸 → 取登记时间最新的（solo），它自己一摞
    expect(currentSheet(board()).id).toBe('solo');
    expect(currentSheet(board(), 'p1').slots.main.w).toBe(600);
  });

  it('纸不存在时不炸，返回空', () => {
    expect(slotsOf(board(), '没这张')).toEqual({});
    expect(resolveSheet(board(), '没这张')).toBeNull();
  });
});
