/** 整组变换（2026-08-30）：涂鸦真变形、其他只换座、绕组心。 */
import { describe, it, expect } from 'vitest';
import { transformGroup } from './board-transform.js';

const members = [
  { id: 'scribble:a', entry: { x: 0, y: 0, data: { d: 'M 0 0 L 100 0' } }, w: 100, h: 10 },
  { id: 'text:b', entry: { x: 200, y: 0, data: { t: '标签' } }, w: 100, h: 20 },
];

describe('transformGroup', () => {
  it('scale 2×：涂鸦线长真的翻倍；文字只挪位、尺寸不动', () => {
    const r = transformGroup(members, { scale: 2 });
    expect(r.inked).toBe(1); expect(r.seated).toBe(1);
    const s = r.patch['scribble:a'];
    expect(s.w).toBeGreaterThan(190);
    const t = r.patch['text:b'];
    expect(t.data.t).toBe('标签');
    expect(t.x).not.toBe(200);
  });
  it('rotate 90°：水平线变竖直线（bbox 宽高互换）', () => {
    const r = transformGroup([members[0]], { rotate: 90 });
    const s = r.patch['scribble:a'];
    expect(s.h).toBeGreaterThan(s.w);
  });
  it('绕组心：组的中心点变换前后不动（scale 时）', () => {
    const r = transformGroup(members, { scale: 0.5 });
    const c0 = { x: (0 + 300) / 2, y: (0 + 20) / 2 };
    expect(Math.abs(r.center.x - c0.x)).toBeLessThan(1);
  });
});
