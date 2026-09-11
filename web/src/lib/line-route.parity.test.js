/**
 * 绕线算法的跨前后端 parity 钉子（2026-09-11，board-kind-sizes / text-box parity 同款纪律）。
 * 前端画的线跟服务端在 agent 返回里报的「穿没穿」必须是同一回事 —— 改一边忘另一边直接红。
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../../server/lib/line-route.js';
import { baseControl, curveHits, routeLine, nearLine, DETOUR_OFFSETS, SIDE_OFFSETS } from './line-route.js';
import { edgePoints, bindingGeometry } from './board-bindings.js';

const col = (n, x = 0) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, x, y: i * 140, w: 384, h: 120 }));
const cases = [
  { name: '一列跳过中间三张', a: col(5)[0], b: col(5)[4], obs: col(5).slice(1, 4) },
  { name: '横排跳过中间一张', a: { id: 'a', x: 0, y: 0, w: 200, h: 100 }, b: { id: 'b', x: 600, y: 0, w: 200, h: 100 }, obs: [{ id: 'm', x: 300, y: 0, w: 200, h: 100 }] },
  { name: '对角、没挡', a: { id: 'a', x: 0, y: 0, w: 200, h: 100 }, b: { id: 'b', x: 700, y: 500, w: 200, h: 100 }, obs: [{ id: 'far', x: -900, y: 900, w: 200, h: 100 }] },
  { name: '对角、中间挡一张', a: { id: 'a', x: 0, y: 0, w: 200, h: 100 }, b: { id: 'b', x: 700, y: 500, w: 200, h: 100 }, obs: [{ id: 'mid', x: 330, y: 230, w: 240, h: 140 }] },
  { name: '两侧堵死', a: col(3)[0], b: col(3)[2], obs: [col(3)[1], { id: 'L', x: -2400, y: -2000, w: 2380, h: 5000 }, { id: 'R', x: 404, y: -2000, w: 2400, h: 5000 }] },
];

describe('line-route parity（前端 ↔ 服务端）', () => {
  it('常量一致', () => {
    expect(DETOUR_OFFSETS).toEqual(server.DETOUR_OFFSETS);
    expect(SIDE_OFFSETS).toEqual(server.SIDE_OFFSETS);
  });
  for (const c of cases) {
    it(`同一组输入同一个结果：${c.name}`, () => {
      expect(edgePoints(c.a, c.b, 6)).toEqual(server.edgePoints(c.a, c.b, 6));
      const { from, to } = edgePoints(c.a, c.b, 6);
      for (const m of ['ink', 'pencil', 'yarn']) {
        const base = baseControl(from, to, m);
        expect(base).toEqual(server.baseControl(from, to, m));
        expect(curveHits(from, base, to, c.obs)).toEqual(server.curveHits(from, base, to, c.obs));
        expect(routeLine(c.a, c.b, m, c.obs)).toEqual(server.routeLine(c.a, c.b, m, c.obs));
        expect(nearLine(c.a, c.b, c.obs)).toEqual(server.nearLine(c.a, c.b, c.obs));
      }
    });
  }
});

describe('bindingGeometry 接上绕线', () => {
  it('不给控制点时跟以前逐字一样（三种材质）', () => {
    const from = { x: 0, y: 0 }; const to = { x: 400, y: 50 };
    for (const m of ['ink', 'pencil', 'yarn']) expect(bindingGeometry(from, to, m, 'k', null)).toEqual(bindingGeometry(from, to, m, 'k'));
  });

  it('一列跳过中间三张：按 routeLine 画出来的墨线，控制点就是绕开的那个，谁都不穿', () => {
    const [c1, c2, c3, c4, c5] = col(5);
    const r = routeLine(c1, c5, 'ink', [c2, c3, c4]);
    const g = bindingGeometry(r.from, r.to, 'ink', 'k', r.ctrl);
    const [, cx, cy] = g.d.match(/Q ([-\d.]+) ([-\d.]+)/).map(Number);
    expect({ x: cx, y: cy }).toEqual(r.ctrl);
    expect(curveHits(r.from, r.ctrl, r.to, [c2, c3, c4])).toEqual([]);
  });

  it('nearLine 不漏掉够得着的：用它筛过跟不筛算出来一样', () => {
    for (const c of cases) {
      const all = [...c.obs, { id: 'x', x: 9000, y: 9000, w: 100, h: 100 }];
      expect(routeLine(c.a, c.b, 'ink', nearLine(c.a, c.b, all))).toEqual(routeLine(c.a, c.b, 'ink', all));
    }
  });
});
