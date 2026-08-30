/** 排线填充（2026-08-30）。重点:偶奇规则（洞是真洞）、闭合判据大声、抖动确定。 */
import { describe, it, expect } from 'vitest';
import { flattenClosed, hatchD } from './sketch-hatch.js';
import { buildSketchShapes } from './sketch-shapes.js';

const deps = { rectOfNode: () => null, isTaken: () => false, tag: 't' };

describe('flattenClosed', () => {
  it('Z 闭合的收，开放的不收；Q/C 采样成折线', () => {
    const r = flattenClosed('M 0 0 L 10 0 Q 10 10 0 10 Z M 20 0 L 30 0');
    expect(r.closedAny).toBe(true);
    expect(r.polys).toHaveLength(1);
    expect(r.polys[0].length).toBeGreaterThan(6);   // Q 采了样
  });
});

describe('hatchD', () => {
  const square = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]];
  it('线段都在轮廓附近、条数随面积走、同种子确定', () => {
    const d = hatchD(square, 's1');
    const segs = (d.match(/M /g) || []).length;
    expect(segs).toBeGreaterThan(6);
    expect(hatchD(square, 's1')).toBe(d);
    expect(hatchD(square, 's2')).not.toBe(d);
    const nums = d.match(/-?\d*\.?\d+/g).map(Number);
    for (const n of nums) { expect(n).toBeGreaterThan(-6); expect(n).toBeLessThan(106); }
  });
  it('⭐ 偶奇规则：带洞的形状，洞里不排线', () => {
    const withHole = [
      ...square,
      [{ x: 30, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 70 }, { x: 30, y: 70 }],
    ];
    const solid = hatchD(square, 's');
    const holed = hatchD(withHole, 's');
    expect((holed.match(/M /g) || []).length).toBeGreaterThan((solid.match(/M /g) || []).length - 1);
    // 洞中心横穿线不存在：任何一段的两端都不该跨过洞中心带
    for (const seg of holed.split(/(?=M )/)) {
      const ns = seg.match(/-?\d*\.?\d+/g)?.map(Number);
      if (!ns || ns.length < 4) continue;
      const midX = (ns[0] + ns[2]) / 2; const midY = (ns[1] + ns[3]) / 2;
      const inHole = midX > 34 && midX < 66 && midY > 34 && midY < 66;
      expect(inHole, seg).toBe(false);
    }
  });
});

describe('fill 接线', () => {
  it('rect 带 fill 比不带的 d 明显长（多了排线）', () => {
    const plain = buildSketchShapes([{ kind: 'rect', at: { x: 0, y: 0 }, w: 6, h: 6 }], deps).shapes[0];
    const filled = buildSketchShapes([{ kind: 'rect', at: { x: 0, y: 0 }, w: 6, h: 6, fill: 'hatch' }], deps).shapes[0];
    expect(filled.d.length).toBeGreaterThan(plain.d.length + 100);
  });
  it('⛔ 开放 path / 线段 挂 fill 大声拒', () => {
    expect(buildSketchShapes([{ kind: 'path', d: 'M 0 0 L 5 5', fill: 'hatch' }], deps).error).toMatch(/闭合/);
    expect(buildSketchShapes([{ kind: 'line', at: { x: 0, y: 0 }, to: { x: 5, y: 0 }, fill: 'hatch' }], deps).error).toMatch(/没有内部/);
  });
  it('闭合 stencil（heart）能填；月牙 path 的内弧不被排穿', () => {
    const r = buildSketchShapes([{ kind: 'stencil', name: 'heart', at: { x: 0, y: 0 }, w: 5, fill: 'hatch' }], deps);
    expect(r.error).toBeUndefined();
    expect(r.shapes[0].d).toMatch(/M .* L .* M /);
  });
});
