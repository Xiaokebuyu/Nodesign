/**
 * 暂存架几何：前端那份 == 服务端那份。
 *
 * ⚠️ 这条比的是**行为不是常量**。「两个常量相等」只证明两份拷贝一致、不证明
 * 它们对（08-30 的 board-kind-sizes.parity 就栽在这上面：两边都写 148，而屏幕上
 * 是 369）。所以这里拿一批真实形状的输入逐例跑两份实现，比落点。
 *
 * 前端为什么必须有一份：服务端入座器有 1.5s 防抖，窗口里前端 fresh-seater 会
 * 抢先落座；空 mkdir 出的文件夹服务端根本收不到 file_changed。两个口都得进架。
 *
 * 2026-09-01 架改成一摞之后这份缩了一大截：折列那一族（SHELF_COL_H /
 * SHELF_COL_STEP / shelfColumnX / COL_LIMIT）两边一起退役，剩下的就是「架在哪」。
 */
import { describe, it, expect } from 'vitest';
import { nextShelfSpot as webSpot, hasShelf, SHELF_W, SHELF_GAP, SHELF_H } from './board-shelf.js';
import {
  nextShelfSpot as srvSpot,
  SHELF_W as SRV_W, SHELF_GAP as SRV_GAP, SHELF_H as SRV_H,
} from '../../../server/lib/board-shelf.js';

describe('board-shelf 前后端 parity', () => {
  it('常量对齐', () => {
    expect([SHELF_W, SHELF_GAP, SHELF_H]).toEqual([SRV_W, SRV_GAP, SRV_H]);
  });

  it('⭐ 落点逐例一致（含负原点、小数、连码多件）', () => {
    for (const origin of [{ x: 0, y: 0 }, { x: -504, y: -72 }, { x: 24, y: 24 }, { x: 23.6, y: -0.4 }]) {
      for (let i = 0; i < 5; i += 1) {
        expect(webSpot(origin), JSON.stringify(origin)).toEqual(srvSpot(origin));
      }
    }
  });

  it('hasShelf 只认两个有限数', () => {
    expect(hasShelf({ x: 0, y: 0 })).toBe(true);
    expect(hasShelf(null)).toBe(false);
    expect(hasShelf({ x: 0 })).toBe(false);
    expect(hasShelf({ x: NaN, y: 0 })).toBe(false);
  });
});
