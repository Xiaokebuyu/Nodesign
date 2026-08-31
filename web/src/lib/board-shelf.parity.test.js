/**
 * 暂存架几何：前端那份 == 服务端那份（2026-08-31 折列）。
 *
 * ⚠️ 这条比的是**行为不是常量**。「两个常量相等」只证明两份拷贝一致、不证明
 * 它们对（08-30 的 board-kind-sizes.parity 就栽在这上面：两边都写 148，而屏幕上
 * 是 369）。所以这里拿一批真实形状的输入逐例跑两份实现，比落点。
 *
 * 前端为什么必须有一份：服务端入座器有 1.5s 防抖，窗口里前端 fresh-seater 会
 * 抢先落座；空 mkdir 出的文件夹服务端根本收不到 file_changed。两个口都得进架。
 */
import { describe, it, expect } from 'vitest';
import { nextShelfSpot as webSpot, shelfColumnX as webColX, SHELF_W, SHELF_GAP, SHELF_COL_H, SHELF_COL_STEP } from './board-shelf.js';
import {
  nextShelfSpot as srvSpot, shelfColumnX as srvColX,
  SHELF_W as SRV_W, SHELF_GAP as SRV_GAP, SHELF_COL_H as SRV_COL_H, SHELF_COL_STEP as SRV_STEP,
} from '../../../server/lib/board-shelf.js';

describe('board-shelf 前后端 parity', () => {
  it('常量对齐', () => {
    expect([SHELF_W, SHELF_GAP, SHELF_COL_H, SHELF_COL_STEP]).toEqual([SRV_W, SRV_GAP, SRV_COL_H, SRV_STEP]);
  });

  it('列坐标逐列一致（含负原点）', () => {
    for (const origin of [{ x: 0, y: 0 }, { x: -504, y: -72 }, { x: 24, y: 24 }]) {
      for (let c = 0; c < 6; c += 1) expect(webColX(origin, c)).toBe(srvColX(origin, c));
    }
  });

  /** 连着码 N 件：每一件都拿两份实现各算一次，落点必须逐件相同 */
  const stack = (spotFn, origin, boxes, seed = []) => {
    const obstacles = [...seed];
    const out = [];
    for (const b of boxes) {
      const s = spotFn(origin, obstacles, b);
      out.push({ x: s.x, y: s.y, col: s.col });
      obstacles.push({ x: s.x, y: s.y, w: b?.w ?? 200, h: b?.h ?? 148 });
    }
    return out;
  };

  const CASES = [
    { name: '11 件卡（proj_mth8wd7k 架上那一批的形状）', origin: { x: -504, y: -72 }, boxes: Array.from({ length: 11 }, () => ({ w: 200, h: 148 })), seed: [] },
    { name: '26 件混合尺寸（proj_mtg61or1 的量级）', origin: { x: 24, y: 24 }, boxes: Array.from({ length: 26 }, (_, i) => ({ w: 200 + (i % 3) * 60, h: 120 + (i % 5) * 70 })), seed: [] },
    { name: '架上已经堵着别人的卡', origin: { x: 0, y: 0 }, boxes: Array.from({ length: 8 }, () => ({ w: 288, h: 240 })), seed: [{ x: 40, y: 300, w: 300, h: 200 }, { x: -400, y: 0, w: 200, h: 500 }] },
    { name: '一件比整列还高', origin: { x: 0, y: 0 }, boxes: [{ w: 200, h: 148 }, { w: 300, h: 2400 }, { w: 200, h: 148 }], seed: [] },
    { name: '不给尺寸（老调用形态）', origin: { x: 0, y: 0 }, boxes: [null, null, null], seed: [{ x: 0, y: 0, w: 200, h: 400 }] },
  ];

  for (const c of CASES) {
    it(`落点逐件一致 · ${c.name}`, () => {
      const web = stack(webSpot, c.origin, c.boxes, c.seed);
      const srv = stack(srvSpot, c.origin, c.boxes, c.seed);
      expect(web).toEqual(srv);
    });
  }
});

describe('折列本身（不是 parity，是这条规则对不对）', () => {
  const origin = { x: 0, y: 0 };
  it('⭐ 一列码满一屏就换列 —— 架不再是一根不封口的柱子', () => {
    const obstacles = [];
    const ys = [];
    for (let i = 0; i < 20; i += 1) {
      const s = webSpot(origin, obstacles, { w: 200, h: 172 });
      obstacles.push({ x: s.x, y: s.y, w: 200, h: 172 });
      ys.push(s.y);
    }
    // 竖向跨度封在一屏内（老实现 20 件会拉到 3920px）
    expect(Math.max(...ys) + 172 - origin.y).toBeLessThanOrEqual(SHELF_COL_H);
    // 确实换了列，而且是往左（远离纸）
    const xs = [...new Set(obstacles.map(o => o.x))];
    expect(xs.length).toBeGreaterThan(1);
    expect(Math.min(...xs)).toBeLessThan(origin.x);
  });

  it('⛔ 一件比整列还高：放进空列，不许把 40 列全跳完', () => {
    const s = webSpot(origin, [], { w: 300, h: 2400 });
    expect(s).toEqual({ x: 0, y: 0, col: 0 });
  });

  it('空架 → 原点（老行为不变）', () => {
    expect(webSpot(origin, [], { w: 200, h: 148 })).toEqual({ x: 0, y: 0, col: 0 });
  });
});
