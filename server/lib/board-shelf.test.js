/**
 * 暂存架几何（2026-08-30）。钉三件事：原点的立法（视口 > 纸群左侧 > 兜底、
 * 被纸压住要搬家）、码放避让（判据是矩形不是 seat —— 用户拖来的卡也得让）、
 * 成员判据（seat:'shelf' 单一真相）。
 */
import { describe, it, expect } from 'vitest';
import { resolveShelfOrigin, nextShelfSpot, shelfItems, SHELF_W, SHELF_GAP } from './board-shelf.js';

describe('resolveShelfOrigin', () => {
  it('已立的原点沿用（changed:false）', () => {
    const o = resolveShelfOrigin({ shelf: { x: -100, y: 50 } }, { x: 0, y: 0 });
    expect(o).toEqual({ x: -100, y: 50, changed: false });
  });

  it('没立过、没纸 → 用户视口左上（到货要看得见）；没视口兜底 (24,24)', () => {
    expect(resolveShelfOrigin({}, { x: 300, y: -116, w: 1948, h: 926 })).toEqual({ x: 324, y: -92, changed: true });
    expect(resolveShelfOrigin({}, null)).toEqual({ x: SHELF_GAP, y: SHELF_GAP, changed: true });
  });

  it('没立过、有纸 → 纸群左侧（架不跟 agent 的地抢）', () => {
    const b = { sheets: { p1: { x: 0, y: 0, w: 1600, h: 900 }, p2: { x: 1700, y: 100, w: 800, h: 600 } } };
    expect(resolveShelfOrigin(b, { x: 500, y: 500 })).toEqual({ x: -SHELF_W - SHELF_GAP, y: 0, changed: true });
  });

  it('⭐ 原点被后来铺的纸压住 → 搬去纸群左侧重立（agent 的纸权大）', () => {
    const b = { shelf: { x: 24, y: 24 }, sheets: { p1: { x: 0, y: 0, w: 1600, h: 900 } } };
    const o = resolveShelfOrigin(b, null);
    expect(o.changed).toBe(true);
    expect(o.x).toBe(-SHELF_W - SHELF_GAP);
  });
});

describe('nextShelfSpot', () => {
  const origin = { x: 24, y: 24 };
  it('空架 → 原点', () => {
    expect(nextShelfSpot(origin, [])).toEqual({ x: 24, y: 24 });
  });
  it('架带内的矩形往下让；带外和原点上方的不算', () => {
    const spot = nextShelfSpot(origin, [
      { x: 24, y: 24, w: 200, h: 176 },              // 架上第一件
      { x: 24 + SHELF_W + 10, y: 24, w: 400, h: 400 },  // 带外：不算
      { x: 24, y: -300, w: 200, h: 200 },            // 原点上方：不算
    ]);
    expect(spot).toEqual({ x: 24, y: 24 + 176 + SHELF_GAP });
  });
  it('⭐ 避让不看 seat：用户拖来堵在架上的卡也得让（压上去是数据损坏）', () => {
    const spot = nextShelfSpot(origin, [{ x: 100, y: 500, w: 300, h: 100, seat: 'user' }]);
    expect(spot.y).toBe(500 + 100 + SHELF_GAP);
  });
});

describe('shelfItems', () => {
  it('只认根层 seat:shelf；挪过的（agent/user）自然离架', () => {
    const b = { objects: {
      a: { x: 0, y: 0, seat: 'shelf' },
      b: { x: 0, y: 0, seat: 'shelf', zone: '素材' },   // 文件夹层：不算
      c: { x: 0, y: 0, seat: 'agent' },
      d: { x: 0, y: 0, seat: 'user' },
      e: { seat: 'shelf' },                              // 没坐标：不算
    } };
    expect(shelfItems(b)).toEqual(['a']);
  });
});
