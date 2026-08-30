/**
 * 词汇表 + 算子（2026-08-30 画图能力线刀①④）。
 * 判据重心：几何算术真的归了机器（等距/旋转/对称/播撒），每份笔迹各自抖，
 * 错法都大声（未知词点名词表、算子互斥、展开超量拒收）。
 */
import { describe, it, expect } from 'vitest';
import { buildSketchShapes } from './sketch-shapes.js';
import { STENCIL_NAMES, stencilStrokes } from './sketch-stencils.js';
import { UNIT } from './sketch-layout.js';

const deps = { rectOfNode: () => null, isTaken: () => false, tag: 't' };
const one = (s) => buildSketchShapes([s], deps);

describe('stencil 词汇表', () => {
  it('16 个词都展得开、缩放对（w 给格，h 缺省按比例）', () => {
    for (const name of STENCIL_NAMES) {
      const r = one({ kind: 'stencil', name, at: { x: 2, y: 3 }, w: 5 });
      expect(r.error, name).toBeUndefined();
      const sh = r.shapes[0];
      expect(sh.rect.w).toBeGreaterThanOrEqual(5 * UNIT);
      expect(sh.d.length, name).toBeGreaterThan(30);
    }
  });

  it('flip 水平镜像：门把手从右边翻到左边（x 反、y 不动）', () => {
    const a = one({ kind: 'stencil', name: 'door', at: { x: 0, y: 0 }, w: 5 }).shapes[0];
    const b = one({ kind: 'stencil', name: 'door', at: { x: 0, y: 0 }, w: 5, flip: true }).shapes[0];
    expect(a.d).not.toBe(b.d);
    const ys = (d) => d.match(/-?\d*\.?\d+/g).filter((_, k) => k % 2 === 1).join();
    expect(ys(a.d)).toBe(ys(b.d));
  });

  it('⛔ 未知词大声拒并报出词表', () => {
    const r = one({ kind: 'stencil', name: 'dragon', at: { x: 0, y: 0 }, w: 5 });
    expect(r.error).toMatch(/认识这些名字/);
    expect(r.error).toMatch(/person/);
  });
});

describe('算子', () => {
  it('⭐ repeat：n 份等距，且每份笔迹不同（重新手画，不是图章）', () => {
    const r = one({ id: 'w', kind: 'rect', at: { x: 0, y: 0 }, w: 2, h: 2, repeat: { n: 4, dx: 3 } });
    expect(r.shapes).toHaveLength(4);
    expect(r.shapes.map((s) => s.key)).toEqual(['w', 'w-2', 'w-3', 'w-4']);
    expect(r.shapes[1].rect.x - r.shapes[0].rect.x).toBe(3 * UNIT);
    expect(r.shapes[3].rect.x - r.shapes[2].rect.x).toBe(3 * UNIT);
    expect(r.shapes[0].d).not.toBe(r.shapes[1].d);
  });

  it('⭐ ring：n 份绕圆心，各份到圆心等距（旋转是刚体变换）', () => {
    const r = one({ id: 'c', kind: 'stencil', name: 'person', at: { x: 10, y: 0 }, w: 2, ring: { n: 6, cx: 10, cy: 8 } });
    expect(r.shapes).toHaveLength(6);
    const C = { x: 10 * UNIT, y: 8 * UNIT };
    const dists = r.shapes.map((s) => {
      const mx = s.rect.x + s.rect.w / 2; const my = s.rect.y + s.rect.h / 2;
      return Math.hypot(mx - C.x, my - C.y);
    });
    for (const d of dists) expect(Math.abs(d - dists[0])).toBeLessThan(8);
  });

  it('mirror：对称补一份，轴两侧等距', () => {
    const r = one({ id: 'h', kind: 'path', d: 'M 0 0 Q 3 2 0 4', mirror: { axis: 'x', at: 5 } });
    expect(r.shapes).toHaveLength(2);
    const [a, b] = r.shapes;
    const ax = 5 * UNIT;
    expect(Math.abs((ax - (a.rect.x + a.rect.w)) - ((b.rect.x) - ax))).toBeLessThan(3);
  });

  it('scatter：n 份都落在区域内、大小有别、同参重放一致', () => {
    const spec = { id: 's', kind: 'stencil', name: 'star', at: { x: 0, y: 0 }, w: 1, scatter: { n: 8, in: { x: 0, y: 0, w: 30, h: 10 } } };
    const r1 = one(spec); const r2 = one(spec);
    expect(r1.shapes).toHaveLength(8);
    for (const sh of r1.shapes) {
      expect(sh.rect.x).toBeGreaterThanOrEqual(-2);
      expect(sh.rect.x + sh.rect.w).toBeLessThanOrEqual(30 * UNIT + 30);
      expect(sh.rect.y + sh.rect.h).toBeLessThanOrEqual(10 * UNIT + 30);
    }
    const sizes = new Set(r1.shapes.map((s) => s.rect.w));
    expect(sizes.size).toBeGreaterThan(2);
    expect(r1.shapes.map((s) => `${s.rect.x},${s.rect.y}`)).toEqual(r2.shapes.map((s) => `${s.rect.x},${s.rect.y}`));
  });

  it('⛔ 算子互斥；展开超 120 件拒收（都大声）', () => {
    expect(one({ kind: 'rect', at: { x: 0, y: 0 }, w: 2, repeat: { n: 3, dx: 3 }, mirror: { axis: 'x', at: 5 } }).error).toMatch(/一次只能挂一个/);
    const many = buildSketchShapes(Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, kind: 'rect', at: { x: 0, y: i * 3 }, w: 2, repeat: { n: 24, dx: 2 } })), deps);
    expect(many.error).toMatch(/超过 120/);
  });

  it('⛔ repeat 零步长拒收（n 份叠原地不是任何人想要的）', () => {
    expect(one({ kind: 'rect', at: { x: 0, y: 0 }, w: 2, repeat: { n: 3 } }).error).toMatch(/步长/);
  });
});

describe('stencilStrokes 缩放', () => {
  it('x 按 w 缩、y 按 h 缩，跨笔画不错位', () => {
    const { strokes, w, h } = stencilStrokes('house', 200, 100);
    expect(w).toBe(200); expect(h).toBe(100);
    const nums = strokes.join(' ').match(/-?\d*\.?\d+/g).map(Number);
    expect(Math.max(...nums.filter((_, k) => k % 2 === 0))).toBeLessThanOrEqual(200);
  });
});
