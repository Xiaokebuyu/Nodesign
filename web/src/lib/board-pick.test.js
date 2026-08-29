// 几何点选与叠堆下翻（2026-08-27；单击语义改「直接开标注」后从
// action-bar-place.test.js 保留下来的那半 —— placeBar 随点选操作条一起撤役）。
//
// 为什么钉：点选走几何不走 DOM 的理由见 board-geometry.js 那节头注 —— 指针
// 捕获下 DOM 命中会被重定向，断了这条用户就点不中叠堆里的东西。
import { describe, it, expect } from 'vitest';
import { hitsAt, nextPick } from './board-geometry.js';

describe('hitsAt + nextPick：几何点选与叠堆下翻', () => {
  const szOf = (o) => ({ w: o.w, h: o.h });
  const pile = [
    { id: 'a', pos: { x: 0, y: 0, z: 1 }, w: 100, h: 100 },
    { id: 'b', pos: { x: 20, y: 20, z: 5 }, w: 100, h: 100 },
    { id: 'c', pos: { x: 40, y: 40, z: 3 }, w: 100, h: 100 },
  ];

  it('命中按 z 从高到低（点到的先是最上面那张）', () => {
    expect(hitsAt(pile, szOf, { x: 50, y: 50 })).toEqual(['b', 'c', 'a']);
  });

  it('点空地命中为空', () => {
    expect(hitsAt(pile, szOf, { x: 500, y: 500 })).toEqual([]);
  });

  it('⭐ 下翻：再点同一处选底下那件，到底绕回顶', () => {
    const hits = ['b', 'c', 'a'];
    expect(nextPick(hits, null)).toBe('b');
    expect(nextPick(hits, 'b')).toBe('c');
    expect(nextPick(hits, 'c')).toBe('a');
    expect(nextPick(hits, 'a')).toBe('b');      // 绕回
  });

  it('当前选中不在这摞里 → 从顶选起；空命中 → null（取消选中）', () => {
    expect(nextPick(['b', 'c'], 'zzz')).toBe('b');
    expect(nextPick([], 'b')).toBeNull();
  });
});
