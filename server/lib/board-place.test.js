import { describe, it, expect } from 'vitest';
import { resolvePlacement, describePlacement, inflateSpriteSeats, UNIT } from './board-place.js';

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

  // ── 连线走廊（2026-08-27 观感措施）────────────────────────────────────
  // near 落位几乎总配一条到锚点的线；理想位被占、就近环搜时，选出来的位置
  // 不该让这条线横穿第三块。断言打在契约上（线段不压块），不钉具体坐标 ——
  // 环搜的遍历序是实现细节。
  it('⭐ 连线走廊：理想位被占时，落点到锚点的线不横穿占位的那块', () => {
    const anchor = { x: 0, y: 0, w: 96, h: 96 };
    const blocker = { x: 120, y: 0, w: 96, h: 96 };   // 正好压住 near-right 的理想位
    const b = { w: 96, h: 96 };
    const r = resolvePlacement({ box: b, anchor, side: 'right', obstacles: [anchor, blocker] });
    expect(r.resolution.startsWith('near-')).toBe(true);
    // 锚点中心 → 落点中心 的线段不得穿过 blocker
    const a = { x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 };
    const c = { x: r.x + b.w / 2, y: r.y + b.h / 2 };
    // 参数化采样足够判定（线段短、块是轴对齐矩形）
    let crosses = false;
    for (let t = 0; t <= 1; t += 0.01) {
      const px = a.x + (c.x - a.x) * t; const py = a.y + (c.y - a.y) * t;
      if (px >= blocker.x && px <= blocker.x + blocker.w && py >= blocker.y && py <= blocker.y + blocker.h) crosses = true;
    }
    expect(crosses).toBe(false);
  });

  it('连线走廊是偏好不是硬闸：处处压线也照样落位（保底 + 最多多看 3 圈）', () => {
    // 一堵纵贯的高墙挡在右侧：右半平面任何落点的连线都必穿墙，左侧近圈又全被
    // 锚点自己占着 —— 只能收下压线的保底位，绝不返回失败
    const anchor = { x: 0, y: 0, w: 96, h: 96 };
    const wall = { x: 120, y: -2000, w: 48, h: 4000 };
    const b = { w: 96, h: 96 };
    const r = resolvePlacement({ box: b, anchor, side: 'right', obstacles: [anchor, wall] });
    expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
    // 落点自己不压墙（落位硬约束仍然成立）
    expect(r.x >= wall.x + wall.w + 12 || r.x + b.w + 12 <= wall.x).toBe(true);
  });

  it('describePlacement：文案从真实 resolution 生成', () => {
    const r = { resolution: 'near-left', nudged: false, rejected: null };
    expect(describePlacement(r)).toContain('left of the anchor');
    const far = { resolution: 'viewport', nudged: false, rejected: 'farfield' };
    expect(describePlacement(far, { requestedAt: { x: 50000, y: 0 } })).toContain('outside the working area');
  });
});

describe('inflateSpriteSeats：精灵身位（08-27 清「findSpot 看不见精灵」挂账）', () => {
  const objects = {
    'a.md': { by: 'agent', x: 0, y: 0 },
    'chalk/one.md': { by: 'rp-moli', x: 100, y: 100 },
    'chalk/two.md': { by: 'rp-moli', x: 400, y: 100 },   // 墨璃最新的 —— 精灵贴这条
    'chalk/npc.md': { by: 'rp-yanqing', x: 100, y: 400 },
  };
  const obs = [
    { id: 'a.md', x: 0, y: 0, w: 100, h: 50 },
    { id: 'chalk/one.md', x: 100, y: 100, w: 200, h: 60 },
    { id: 'chalk/two.md', x: 400, y: 100, w: 200, h: 60 },
    { id: 'chalk/npc.md', x: 100, y: 400, w: 200, h: 60 },
  ];

  it('⭐ 只给每个角色**最新**一条让身位（精灵贴的是它），旧条和非角色不动', () => {
    const out = inflateSpriteSeats(obs, objects);
    const byId = Object.fromEntries(out.map((o) => [o.id, o]));
    expect(byId['chalk/two.md'].x).toBe(340);            // 400 − 60
    expect(byId['chalk/two.md'].w).toBe(320);            // 200 + 120
    expect(byId['chalk/npc.md'].x).toBe(40);             // 砚青只有一条，也是最新
    expect(byId['chalk/one.md'].x).toBe(100);            // 旧条原样
    expect(byId['a.md'].x).toBe(0);                      // 主控的不让
  });

  it('板上没有角色板书 → 原表原样返回（零成本路径）', () => {
    const plain = [{ id: 'a.md', x: 0, y: 0, w: 100, h: 50 }];
    expect(inflateSpriteSeats(plain, { 'a.md': { by: 'agent', x: 0 } })).toBe(plain);
  });
});
