import { describe, it, expect } from 'vitest';
import { resolvePlacement, describePlacement, UNIT } from './board-place.js';

const box = { w: 200, h: 100 };
const rect = (x, y, w = 200, h = 100) => ({ x, y, w, h });

describe('resolvePlacement', () => {
  it('reply_to：正下方同列', () => {
    const r = resolvePlacement({ box, replyTo: rect(100, 100) });
    expect(r.resolution).toBe('reply-to');
    expect(r.x).toBe(100);
    expect(r.y).toBe(212);   // y + h + PAD(12)
    expect(r.nudged).toBe(false);
  });

  it('reply_to 被挡：环搜后仍落下方（不失败）', () => {
    const blocker = rect(100, 212);
    const r = resolvePlacement({ box, replyTo: rect(100, 100), obstacles: [blocker] });
    expect(r.resolution).toBe('reply-to');
    expect(r.nudged).toBe(true);
    // 不与 blocker 相交（带 12px 留白）
    expect(r.y >= blocker.y + blocker.h || r.x >= blocker.x + blocker.w || r.x + box.w <= blocker.x).toBe(true);
  });

  it('at 空地：snap 到 24 网格', () => {
    const r = resolvePlacement({ box, at: { x: 250, y: 130 }, obstacles: [rect(0, 0)] });
    expect(r.resolution).toBe('at');
    expect(r.x % UNIT).toBe(0);
    expect(r.y % UNIT).toBe(0);
    expect(Math.abs(r.x - 250)).toBeLessThanOrEqual(UNIT);
  });

  it('at 撞车：就近环搜，nudged 标记', () => {
    const r = resolvePlacement({ box, at: { x: 0, y: 0 }, obstacles: [rect(-24, -24, 260, 160)] });
    expect(r.resolution).toBe('at');
    expect(r.nudged).toBe(true);
  });

  it('at 远场：拒收但不失败，落回视口并标 rejected-farfield', () => {
    const vp = { x: 0, y: 0, w: 1400, h: 900 };
    const r = resolvePlacement({ box, at: { x: 50000, y: 50000 }, obstacles: [rect(0, 0)], viewport: vp });
    expect(r.rejected).toBe('farfield');
    expect(r.resolution).toBe('viewport');
    expect(r.x).toBeLessThan(2000);
  });

  it('空板没有远场：任何 at 都近场收下', () => {
    const r = resolvePlacement({ box, at: { x: 50000, y: 50000 } });
    expect(r.resolution).toBe('at');
    expect(r.rejected).toBe(null);
  });

  it('near 右侧空着：贴右、顶对齐', () => {
    const a = rect(100, 100, 300, 200);
    const r = resolvePlacement({ box, anchor: a, obstacles: [a] });
    expect(r.resolution).toBe('near-right');
    expect(r.x).toBe(a.x + a.w + UNIT);
    expect(r.y).toBe(a.y);
    expect(r.nudged).toBe(false);
  });

  it('side:left 显式给：贴左（08-24 信箱「没有左边」案）', () => {
    const a = rect(1000, 100, 300, 200);
    const r = resolvePlacement({ box, anchor: a, side: 'left', obstacles: [a] });
    expect(r.resolution).toBe('near-left');
    expect(r.x + box.w).toBeLessThanOrEqual(a.x);
    expect(r.y).toBe(a.y);
  });

  it('右侧挤满：换侧就近，resolution 报真实侧位（不再沿一个方向推远）', () => {
    const a = rect(1000, 1000, 300, 200);
    // 右半平面糊一大片墙
    const wall = rect(a.x + a.w, a.y - 2000, 3000, 6000);
    const r = resolvePlacement({ box, anchor: a, obstacles: [a, wall] });
    expect(r.resolution).not.toBe('near-right');
    expect(r.nudged).toBe(true);
    // 落点离锚不超过环搜半径（20 格 + 自身）
    const dist = Math.hypot(r.x - a.x, r.y - a.y);
    expect(dist).toBeLessThan((20 + 16) * UNIT);
  });

  it('无锚无 at：进用户视口（阅读顺序纪律保留）', () => {
    const vp = { x: 500, y: 500, w: 1400, h: 900 };
    const r = resolvePlacement({ box, viewport: vp, obstacles: [rect(500, 500)] });
    expect(r.resolution).toBe('viewport');
    expect(r.x).toBeGreaterThanOrEqual(vp.x);
    expect(r.y).toBeGreaterThanOrEqual(vp.y);
  });

  it('什么都没有：内容底下，左缘对齐', () => {
    const r = resolvePlacement({ box, obstacles: [rect(300, 0)], contentBottom: 100 });
    expect(r.resolution).toBe('bottom');
    expect(r.x).toBe(300);
    expect(r.y).toBe(140);
  });

  it('落位没有失败分支：全板糊死也返回坐标', () => {
    // 一堵覆盖环搜半径的巨墙 + 无视口
    const a = rect(0, 0, 100, 100);
    const wall = rect(-3000, -3000, 6000, 6000);
    const r = resolvePlacement({ box, anchor: a, obstacles: [a, wall], contentBottom: 3000 });
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(r.resolution).toBe('fallback');
  });

  it('describePlacement：文案从真实 resolution 生成', () => {
    const r = { resolution: 'near-left', nudged: false, rejected: null };
    expect(describePlacement(r)).toContain('left of the anchor');
    const far = { resolution: 'viewport', nudged: false, rejected: 'farfield' };
    expect(describePlacement(far, { requestedAt: { x: 50000, y: 0 } })).toContain('outside the working area');
  });
});
