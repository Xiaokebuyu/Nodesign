import { describe, it, expect } from 'vitest';
import {
  stackOfSheet, sheetsInStack, stacksOf, stackRectOf, stackArtifactsRect,
  stackInvariantErrors, neighborStack,
} from './board-stacks.js';

/** 一摞两张 + 旁边一张没登记过摞的（存量形态），左右各一 */
const board = () => ({
  sheets: {
    p1: { x: 0, y: 0, w: 800, h: 600, at: '2026-09-01T01:00:00Z', stack: 'main', title: '第一拍' },
    p2: { x: 0, y: 0, w: 900, h: 640, at: '2026-09-01T02:00:00Z', stack: 'main', title: '第二拍' },
    st: { x: 1000, y: 0, w: 360, h: 240, at: '2026-09-01T03:00:00Z', title: '状态表' },
  },
  stacks: { main: { title: '主线', at: '2026-09-01T01:00:00Z', artifacts: { x: 600, y: 24, w: 240, h: 400 } } },
  objects: {},
});

describe('栈：身份显式、几何派生（2026-09-01 叠纸刀 0）', () => {
  it('没登记过 stack 的纸自己就是一摞（存量板行为不变）', () => {
    expect(stackOfSheet(board(), 'st')).toBe('st');
    expect(stackOfSheet(board(), 'p1')).toBe('main');
    const legacy = { sheets: { a: { x: 0, y: 0, w: 100, h: 100, at: '1' }, b: { x: 0, y: 200, w: 100, h: 100, at: '2' } } };
    expect(stacksOf(legacy).map(s => s.name)).toEqual(['a', 'b']);
    expect(stacksOf(legacy).every(s => s.implicit)).toBe(true);
  });

  it('一摞里的纸按登记时间排（第一张在最底下 = 翻页序）', () => {
    expect(sheetsInStack(board(), 'main').map(s => s.id)).toEqual(['p1', 'p2']);
  });

  it('摞的原点取最早那张，宽高取成员最大值', () => {
    const st = stackRectOf(board(), 'main');
    expect(st).toMatchObject({ x: 0, y: 0, w: 900, h: 640 });
    expect(st.sheets).toEqual(['p1', 'p2']);
  });

  it('登记过的摞用自己的标题，隐式摞回落到那张纸的标题', () => {
    const list = stacksOf(board());
    expect(list.find(s => s.name === 'main').title).toBe('主线');
    expect(list.find(s => s.name === 'st').title).toBe('状态表');
  });

  it('产物地是相对摞原点的，换算成世界坐标要加上原点', () => {
    expect(stackArtifactsRect(board(), 'main')).toEqual({ x: 600, y: 24, w: 240, h: 400 });
    const moved = board();
    moved.sheets.p1.x = 500; moved.sheets.p2.x = 500;
    expect(stackArtifactsRect(moved, 'main')).toEqual({ x: 1100, y: 24, w: 240, h: 400 });
    expect(stackArtifactsRect(board(), 'st')).toBeNull();
  });

  it('⭐ 不变量：同一摞的纸坐标必须相等，歪了要报得出来', () => {
    expect(stackInvariantErrors(board())).toEqual([]);
    const bad = board();
    bad.sheets.p2.y = 700;                    // 第二张掉出了这一摞
    const errs = stackInvariantErrors(bad);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('p2');
  });

  it('单张摞不参与不变量（一张纸不可能跟自己对不上）', () => {
    const one = { sheets: { a: { x: 5, y: 7, w: 100, h: 100, at: '1', stack: 'solo' } } };
    expect(stackInvariantErrors(one)).toEqual([]);
  });

  it('左右换摞按阅读序，到头返回 null 不循环', () => {
    expect(neighborStack(board(), 'main', 1).name).toBe('st');
    expect(neighborStack(board(), 'main', -1)).toBeNull();
    expect(neighborStack(board(), 'st', 1)).toBeNull();
    expect(neighborStack(board(), 'st', -1).name).toBe('main');
  });
});
