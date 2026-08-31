/**
 * 暂存架几何（2026-08-30）。钉三件事：原点的立法（视口 > 纸群左侧 > 兜底、
 * 被纸压住要搬家）、码放避让（判据是矩形不是 seat —— 用户拖来的卡也得让）、
 * 成员判据（seat:'shelf' 单一真相）。
 */
import { describe, it, expect } from 'vitest';
import { resolveShelfOrigin, nextShelfSpot, shelfItems, SHELF_W, SHELF_GAP, SHELF_COL_H } from './board-shelf.js';

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

  it('⭐⭐ 原点在纸群**正上方**（点没被压住，但架带横穿每张纸）→ 照样要搬', () => {
    // proj_mtg61or1 真形状：架立在 (24,24)，第一张纸在 1464px 之下。
    // 判据只测原点那一个点的话，四张纸一张都"压不住"它 —— 而架带 x[24,384)
    // 跟四张纸的横向重叠率是 100%，于是架顺着这条带一路往下长穿了整块板
    // （码到 y=8322，板子声明高度才 2600）。
    const b = {
      shelf: { x: 24, y: 24 },
      sheets: {
        p1: { x: 0, y: 1488, w: 2048, h: 973 },
        p2: { x: 0, y: 2509, w: 2048, h: 360 },
        p3: { x: 0, y: 2917, w: 2048, h: 888 },
        p4: { x: 0, y: 4621, w: 2048, h: 973 },
      },
    };
    const o = resolveShelfOrigin(b, null);
    expect(o.changed, '架带横穿四张纸，必须搬').toBe(true);
    expect(o.x).toBe(-SHELF_W - SHELF_GAP);
    // 搬完之后架带跟纸再无横向重叠 —— 而且这个新原点要稳定，下一轮不能再搬
    expect(o.x + SHELF_W).toBeLessThanOrEqual(0);
    const again = resolveShelfOrigin({ ...b, shelf: { x: o.x, y: o.y } }, null);
    expect(again, '搬到位之后就该沿用，不能来回跳').toEqual({ x: o.x, y: o.y, changed: false });
  });

  it('架在纸**上方**但横向错开 → 不用搬（判的是带不是点）', () => {
    const b = { shelf: { x: -900, y: 0 }, sheets: { p1: { x: 0, y: 500, w: 1600, h: 900 } } };
    expect(resolveShelfOrigin(b, null)).toEqual({ x: -900, y: 0, changed: false });
  });

  it('架在纸**下方**、横向重叠 → 不用搬（纸不在它往下长的路上）', () => {
    const b = { shelf: { x: 24, y: 2000 }, sheets: { p1: { x: 0, y: 0, w: 1600, h: 900 } } };
    expect(resolveShelfOrigin(b, null)).toEqual({ x: 24, y: 2000, changed: false });
  });
});

describe('nextShelfSpot', () => {
  const origin = { x: 24, y: 24 };
  it('空架 → 原点', () => {
    expect(nextShelfSpot(origin, [])).toEqual({ x: 24, y: 24, col: 0 });
  });
  it('架带内的矩形往下让；带外和原点上方的不算', () => {
    const spot = nextShelfSpot(origin, [
      { x: 24, y: 24, w: 200, h: 176 },              // 架上第一件
      { x: 24 + SHELF_W + 10, y: 24, w: 400, h: 400 },  // 带外：不算
      { x: 24, y: -300, w: 200, h: 200 },            // 原点上方：不算
    ]);
    expect(spot).toEqual({ x: 24, y: 24 + 176 + SHELF_GAP, col: 0 });
  });
  it('⭐ 避让不看 seat：用户拖来堵在架上的卡也得让（压上去是数据损坏）', () => {
    const spot = nextShelfSpot(origin, [{ x: 100, y: 500, w: 300, h: 100, seat: 'user' }]);
    expect(spot.y).toBe(500 + 100 + SHELF_GAP);
  });

  /**
   * 折列（2026-08-31）。架原来是一根**不封口**的竖列：真案 proj_mtg61or1 26 件
   * 码到 8322px（板高 2600），前端 ShelfHint 画出来是个 1:41 的虚线框横穿四张纸。
   * ⚠️ 给了 box 才折 —— 不给就是老行为（那是唯一还会长成柱子的调用形态）。
   */
  it('⭐ 给了尺寸就折列：一列码满一屏换下一列，往左长（远离纸）', () => {
    const obstacles = []; const ys = []; const xs = new Set();
    for (let i = 0; i < 20; i += 1) {
      const s = nextShelfSpot(origin, obstacles, { w: 200, h: 172 });
      obstacles.push({ x: s.x, y: s.y, w: 200, h: 172 });
      ys.push(s.y); xs.add(s.x);
    }
    expect(Math.max(...ys) + 172 - origin.y).toBeLessThanOrEqual(SHELF_COL_H);
    expect(xs.size).toBeGreaterThan(1);
    expect(Math.min(...xs)).toBeLessThan(origin.x);
  });

  it('⛔ 不给尺寸 = 老行为（一路往下，不折）', () => {
    const obstacles = []; const ys = [];
    for (let i = 0; i < 20; i += 1) {
      const s = nextShelfSpot(origin, obstacles);
      obstacles.push({ x: s.x, y: s.y, w: 200, h: 172 });
      ys.push(s.y);
    }
    expect(Math.max(...ys)).toBeGreaterThan(SHELF_COL_H);
  });

  it('⛔ 一件比整列还高：给它一个空列，不许把列全跳完', () => {
    expect(nextShelfSpot(origin, [], { w: 300, h: SHELF_COL_H * 2 })).toEqual({ x: 24, y: 24, col: 0 });
  });
});

describe('shelfItems', () => {
  it('只认根层 seat:shelf；挪过的（agent/user）自然离架', () => {
    const b = { zones: { 素材: { x: 0, y: 0 } }, objects: {
      a: { x: 0, y: 0, seat: 'shelf' },
      b: { x: 0, y: 0, seat: 'shelf', zone: '素材' },   // 文件夹层：不算
      c: { x: 0, y: 0, seat: 'agent' },
      d: { x: 0, y: 0, seat: 'user' },
      e: { seat: 'shelf' },                              // 没坐标：不算
    } };
    expect(shelfItems(b)).toEqual(['a']);
  });

  /**
   * 真案 proj_mth8wd7k：架上 11 件全是这个形状 —— 前端 fresh-seater 在文件夹卡
   * 出现之前按根层给了它们架上的座，那种座位**不带 zone 字段**；文件夹随后出现，
   * 卡被渲染进文件夹里，而 board.json 里那条根层架座永远留着。屏幕上架是空的，
   * 状态块每回合报 11 件等安置。
   */
  it('⛔ 层归属按 layerOf 算，不读 zone 字段（前端落的座根本没有那个字段）', () => {
    const b = {
      zones: { '角色': { x: 0, y: 0 }, '角色/晴可': { x: 0, y: 0 } },
      objects: {
        '角色/晴可/角色卡.md': { x: -504, y: 100, z: 1, seat: 'shelf' },   // 无 zone 字段
        '散件.png': { x: -504, y: 300, z: 1, seat: 'shelf' },
      },
    };
    expect(shelfItems(b)).toEqual(['散件.png']);
  });

  it('⛔ 档案目录不算到货（角色/世界书/预设/记忆）', () => {
    const b = { zones: {}, objects: {
      '角色/晴可/角色卡.md': { x: 0, y: 0, seat: 'shelf' },
      '世界书/常驻/世界观.md': { x: 0, y: 0, seat: 'shelf' },
      '记忆/口味.md': { x: 0, y: 0, seat: 'shelf' },
      '预设/晴可/落点对账.md': { x: 0, y: 0, seat: 'shelf' },
      '海报.png': { x: 0, y: 0, seat: 'shelf' },
    } };
    expect(shelfItems(b)).toEqual(['海报.png']);
  });
});
