import { describe, it, expect } from 'vitest';
import { solvePlace, placeBeside, placeBelow, lastOfGroup, describePlacement, SIDES } from './board-place.js';

const box = { w: 432, h: 200 };
const anchor = { id: 'a', x: 1000, y: 1000, w: 400, h: 300 };
const rect = (p) => ({ ...p, w: box.w, h: box.h });
const hits = (r, obs) => obs.some((o) => !(r.x + r.w <= o.x || o.x + o.w <= r.x || r.y + r.h <= o.y || o.y + o.h <= r.y));

describe('solvePlace —— 意图层落位', () => {
  it('贴着锚点、没说侧：缺省右侧', () => {
    const p = solvePlace({ box, anchor, obstacles: [anchor] });
    expect(p.how).toBe('beside'); expect(p.side).toBe('right'); expect(p.nudged).toBe(false);
    expect(p).toMatchObject(placeBeside(anchor, box, 'right'));
  });
  it('偏好的一侧被占：换到别的侧并标 nudged，报文说明原因', () => {
    const blocker = { id: 'b', x: anchor.x + anchor.w + 24, y: anchor.y - 400, w: 600, h: 1400 };
    const p = solvePlace({ box, anchor, side: 'right', obstacles: [anchor, blocker] });
    expect(p.side).not.toBe('right'); expect(p.nudged).toBe(true); expect(p.wanted).toBe('right');
    expect(hits(rect(p), [anchor, blocker])).toBe(false);
    expect(describePlacement(p, { anchorId: 'a' })).toMatch(/no room right/);
  });
  it('偏好侧的起点被占但沿着锚点滑一段就有空：滑而不换侧', () => {
    const blocker = { id: 'b', x: anchor.x + anchor.w + 24, y: anchor.y, w: 500, h: 100 };
    const p = solvePlace({ box, anchor, side: 'right', obstacles: [anchor, blocker] });
    expect(p.side).toBe('right'); expect(p.nudged).toBe(true);
    expect(hits(rect(p), [anchor, blocker])).toBe(false);
  });
  it('四面全堵：螺旋找最近空位（how=near），永远不拒收', () => {
    const wall = (x, y, w, h) => ({ x, y, w, h });
    const obs = [anchor,
      wall(anchor.x - 2000, anchor.y - 2000, 2000 - 12, 5000),           // 左墙
      wall(anchor.x + anchor.w + 12, anchor.y - 2000, 2000, 5000),       // 右墙
      wall(anchor.x - 12, anchor.y - 1000, anchor.w + 24, 1000 - 12),    // 上墙
      wall(anchor.x - 12, anchor.y + anchor.h + 12, anchor.w + 24, 500), // 下墙（有限）
    ];
    const p = solvePlace({ box, anchor, obstacles: obs });
    expect(['near', 'below-content']).toContain(p.how);
    expect(hits(rect(p), obs)).toBe(false);
  });
  it('手机档只许上下', () => {
    const p = solvePlace({ box, anchor, side: 'right', obstacles: [anchor], column: true });
    expect(['below', 'above']).toContain(p.side);
  });
  it('with:<tag> 续写：接在组尾正下方，被挡住就跳到挡它的东西底下', () => {
    const tail = { id: 't', x: 100, y: 100, w: 432, h: 100 };
    const blocker = { id: 'b', x: 100, y: 230, w: 432, h: 300 };
    const p = solvePlace({ box, group: tail, obstacles: [tail, blocker] });
    expect(p.how).toBe('thread'); expect(p.x).toBe(100); expect(p.y).toBe(blocker.y + blocker.h + 24);
  });
  it('没有锚：落在用户视口的空地，按阅读序取第一块', () => {
    const vp = { x: 0, y: 0, w: 1600, h: 1000 };
    const occupied = { id: 'o', x: 24, y: 24, w: 600, h: 400 };
    const p = solvePlace({ box, viewport: vp, obstacles: [occupied] });
    expect(p.how).toBe('in-view');
    expect(p.x).toBeGreaterThanOrEqual(vp.x); expect(p.y).toBeGreaterThanOrEqual(vp.y);
    expect(p.x + box.w).toBeLessThanOrEqual(vp.x + vp.w); expect(p.y + box.h).toBeLessThanOrEqual(vp.y + vp.h);
    expect(hits(rect(p), [occupied])).toBe(false);
  });
  it('视口塞满：贴着视口内容底边往下放（below-view），不压任何东西', () => {
    const vp = { x: 0, y: 0, w: 1000, h: 600 };
    const full = { id: 'f', x: 0, y: 0, w: 1000, h: 600 };
    const p = solvePlace({ box, viewport: vp, obstacles: [full] });
    expect(p.how).toBe('below-view'); expect(p.y).toBeGreaterThanOrEqual(600);
    expect(hits(rect(p), [full])).toBe(false);
  });
  it('什么都没有：内容底下', () => {
    const p = solvePlace({ box, obstacles: [] });
    expect(p.how).toBe('below-content'); expect(p.x).toBe(24); expect(p.y).toBe(0);
  });
  it('⛔ 攻：任何一种结果都不压在障碍上（随机障碍 200 组）', () => {
    let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let k = 0; k < 200; k += 1) {
      const obs = [anchor];
      for (let i = 0; i < 12; i += 1) obs.push({ id: `o${i}`, x: 400 + rnd() * 1600, y: 400 + rnd() * 1600, w: 100 + rnd() * 500, h: 60 + rnd() * 400 });
      const side = SIDES[Math.floor(rnd() * 4)];
      const p = solvePlace({ box, anchor, side, obstacles: obs });
      expect(hits(rect(p), obs)).toBe(false);
    }
  });
});

describe('原语', () => {
  it('placeBelow 没有底：连着 30 件也一路往下接', () => {
    const obs = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: 100 + i * 60, w: 432, h: 50 }));
    const p = placeBelow({ x: 0, y: 0, w: 432, h: 80 }, box, obs);
    expect(p.y).toBeGreaterThan(100 + 29 * 60);
  });
  it('lastOfGroup 取阅读序最后一条（最靠下，再靠右）', () => {
    const board = { objects: { a: { x: 0, y: 0, tag: 't' }, b: { x: 500, y: 0, tag: 't' }, c: { x: 0, y: 300, tag: 't' }, d: { x: 0, y: 0, tag: 'u' } } };
    const last = lastOfGroup(board, 't', () => ({ w: 100, h: 100 }));
    expect(last.id).toBe('c');
  });
});
