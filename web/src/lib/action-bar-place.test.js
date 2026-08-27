// 操作条落位 + 几何点选（2026-08-27 桌面交互重制）
//
// 为什么钉：这条降级链的承诺是「操作条永不出不来」—— 挤成一堆的产物、贴着
// 视口边的卡、全被占满的四周，每一档都要真的落到下一档，断一环用户就点不到
// 操作了。点选走几何不走 DOM 的理由见 action-bar-place.js 头注。
import { describe, it, expect } from 'vitest';
import { placeBar, hitsAt, nextPick } from './action-bar-place.js';

const VP = { w: 1200, h: 800 };
const BAR = { w: 150, h: 30 };

describe('placeBar：降级链', () => {
  it('四周空旷 → 落在正下方（用户点名的首选）', () => {
    const p = placeBar({ target: { x: 500, y: 300, w: 200, h: 100 }, bar: BAR, viewport: VP });
    expect(p.mode).toBe('world');
    expect(p.y).toBe(408);                      // target 底 + gap 8
    expect(p.detached).toBe(false);
  });

  it('下方被占 → 让到上方', () => {
    const below = { x: 400, y: 405, w: 400, h: 60 };
    const p = placeBar({ target: { x: 500, y: 300, w: 200, h: 100 }, bar: BAR, viewport: VP, obstacles: [below] });
    expect(p.mode).toBe('world');
    expect(p.y).toBe(262);                      // target 顶 − gap − 条高
  });

  it('⭐ 卡贴视口下沿：「下」被夹回来压到卡身上不算数，落到上方', () => {
    const p = placeBar({ target: { x: 500, y: 690, w: 200, h: 100 }, bar: BAR, viewport: VP });
    expect(p.mode).toBe('world');
    expect(p.y).toBeLessThan(690);
  });

  it('近圈全占 → 扩到外圈并报 detached（调用方画引线）', () => {
    const ring = [];
    const t = { x: 500, y: 300, w: 200, h: 100 };
    // 把贴身一圈全糊死（上下左右各一块宽障碍）
    ring.push({ x: 300, y: 400, w: 600, h: 40 });
    ring.push({ x: 300, y: 260, w: 600, h: 40 });
    ring.push({ x: 700, y: 200, w: 40, h: 300 });
    ring.push({ x: 460, y: 200, w: 40, h: 300 });
    const p = placeBar({ target: t, bar: BAR, viewport: VP, obstacles: ring });
    expect(p.mode).toBe('world');
    expect(p.detached).toBe(true);
  });

  it('⭐ 三圈全满 → 降级 HUD，永不返回「摆不下」', () => {
    // 一整片障碍把 target 周围全糊死
    const wall = [{ x: 0, y: 0, w: 1200, h: 800 }];
    const p = placeBar({ target: { x: 500, y: 300, w: 200, h: 100 }, bar: BAR, viewport: VP, obstacles: wall });
    expect(p.mode).toBe('hud');
  });

  it('视口比条还小 → 直接 HUD（世界模式没有可行解）', () => {
    expect(placeBar({ target: { x: 0, y: 0, w: 10, h: 10 }, bar: BAR, viewport: { w: 100, h: 40 } }).mode).toBe('hud');
  });
});

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
