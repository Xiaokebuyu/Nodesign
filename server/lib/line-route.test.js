/**
 * 线绕开中间的卡片（09-11 桌面会话：删掉的 9 条线全在看过板之后，一列里 c1→c5 从中间三张卡上直穿）。
 */
import { describe, it, expect } from 'vitest';
import { edgePoints, baseControl, curveHits, routeLine, lineCrossings } from './line-route.js';

const col = (n, x = 0) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, x, y: i * 140, w: 384, h: 120 }));

describe('routeLine', () => {
  it('一列里 c1→c5：默认那条穿过 c2..c4 → 改从侧边出进、往外轻拱，新曲线谁都不穿', () => {
    const [c1, c2, c3, c4, c5] = col(5);
    const { from, to } = edgePoints(c1, c5, 6);
    expect(curveHits(from, baseControl(from, to, 'ink'), to, [c2, c3, c4])).toEqual(['c2', 'c3', 'c4']);
    const r = routeLine(c1, c5, 'ink', [c2, c3, c4]);
    expect(r.detoured).toBe(true);
    expect(r.crossed).toEqual([]);
    // 从同一侧出、同一侧进：整条线在这一列的外侧（先试默认拱的那一侧，竖线的默认拱朝左）
    expect(Math.max(r.from.x, r.to.x) < 0 || Math.min(r.from.x, r.to.x) > 384).toBe(true);
    expect(curveHits(r.from, r.ctrl, r.to, [c2, c3, c4])).toEqual([]);
  });

  it('默认就不穿：原样用默认（前端画出来跟以前逐字一样）', () => {
    const a = { id: 'a', x: 0, y: 0, w: 200, h: 100 }; const b = { id: 'b', x: 500, y: 0, w: 200, h: 100 };
    const { from, to } = edgePoints(a, b, 6);
    expect(routeLine(a, b, 'pencil', [{ id: 'far', x: 0, y: 900, w: 200, h: 100 }]))
      .toEqual({ from, to, ctrl: baseControl(from, to, 'pencil'), crossed: [], detoured: false });
  });

  it('侧边出进的线不许切进两端自己的卡片（09-11 截图：斜线贴着终点底边横着进来，切进它的左下角）', () => {
    const a = { id: 'd1', x: 620, y: 360, w: 220, h: 100 };
    const mid = { id: 'd2', x: 920, y: 500, w: 240, h: 110 };
    const b = { id: 'd3', x: 1200, y: 660, w: 220, h: 100 };
    const r = routeLine(a, b, 'ink', [mid]);
    expect(r.detoured).toBe(true);
    expect(curveHits(r.from, r.ctrl, r.to, [mid, a, b])).toEqual([]);
  });

  it('两侧都堵死：保持默认并报穿了谁', () => {
    const [c1, c2, c3] = col(3);
    const walls = [c2, { id: 'L', x: -2400, y: -2000, w: 2380, h: 5000 }, { id: 'R', x: 404, y: -2000, w: 2400, h: 5000 }];
    const r = routeLine(c1, c3, 'ink', walls);
    expect(r.detoured).toBe(false);
    expect(r.crossed).toContain('c2');
  });
});

describe('lineCrossings（返回里的如实报）', () => {
  const board = () => ({
    objects: Object.fromEntries(col(5).map(({ id, ...r }) => [`text:${id}`, { ...r, kind: 'text', data: { t: id } }])),
    bindings: { 'b:long': { type: 'flow', from: 'text:c1', to: 'text:c5' }, 'b:next': { type: 'flow', from: 'text:c1', to: 'text:c2' } },
  });
  const walled = () => {
    const b = board();
    b.objects['text:L'] = { x: -2400, y: -2000, w: 2380, h: 5000, kind: 'text', data: { t: 'L' } };
    b.objects['text:R'] = { x: 404, y: -2000, w: 2400, h: 5000, kind: 'text', data: { t: 'R' } };
    return b;
  };

  it('绕得开的不报；贴着的两件不管（前端本来就不画）', () => {
    expect(lineCrossings(board(), { bindingIds: ['b:long', 'b:next'] })).toEqual([]);
  });

  it('绕不开的点名：线 id、两端、穿了谁', () => {
    const notes = lineCrossings(walled(), { objectIds: ['text:c5'] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^⚠ 线 b:long（text:c1 → text:c5）绕不开，横穿了 \d+ 件：/);
  });

  it('只看这次动过的：没碰到的线不报', () => {
    expect(lineCrossings(walled(), { objectIds: ['text:L'] })).toEqual([]);
  });
});
