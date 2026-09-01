/**
 * 暂存架几何（2026-08-30）。钉三件事：原点的立法（视口 > 纸群左侧 > 兜底、
 * 被纸压住要搬家）、码放避让（判据是矩形不是 seat —— 用户拖来的卡也得让）、
 * 成员判据（seat:'shelf' 单一真相）。
 */
import { describe, it, expect } from 'vitest';
import { resolveShelfOrigin, nextShelfSpot, shelfItems, SHELF_W, SHELF_GAP, SHELF_H } from './board-shelf.js';

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

  /**
   * ⭐⭐ 这一条 2026-09-01 **翻案了**，历史留在这儿因为它讲的是一整条推理链怎么
   * 随形状变化作废的。
   *
   * 08-30 的判据是「架带横穿纸就得搬」：架当时是一条**从原点往下不封口的竖带**，
   * 真案 proj_mtg61or1 架立在 (24,24)、第一张纸在 1464px 之下，四张纸一张都
   * "压不住"原点那个点，而架带 x[24,384) 跟四张纸横向重叠率 100% —— 架顺着
   * 那条带一路长穿整块板，码到 y=8322（板子声明高度才 2600）。
   *
   * 架改成一摞之后**它不往下长了**，就是一个 360×400 的矩形。纸在它下面 1464px
   * 处不再是任何冲突，所以现在的正确答案是「不用搬」。⭐ 判据的形状要跟被判的
   * 东西的形状对上 —— 那条课这次是反着用的：形状简单了，专门为它想的那条规则
   * 也跟着作废，不该留着。
   */
  it('⭐⭐ 原点在纸群正上方、离得开 → 不用搬（架不再往下长）', () => {
    const b = {
      shelf: { x: 24, y: 24 },
      sheets: {
        p1: { x: 0, y: 1488, w: 2048, h: 973 },
        p2: { x: 0, y: 2509, w: 2048, h: 360 },
        p3: { x: 0, y: 2917, w: 2048, h: 888 },
        p4: { x: 0, y: 4621, w: 2048, h: 973 },
      },
    };
    expect(resolveShelfOrigin(b, null)).toEqual({ x: 24, y: 24, changed: false });
  });

  it('⭐ 但纸真的盖到架位上还是要搬，搬完要稳（不能来回跳）', () => {
    const b = {
      shelf: { x: 24, y: 24 },
      sheets: { p1: { x: 0, y: 0, w: 2048, h: 973 }, p2: { x: 0, y: 1021, w: 2048, h: 973 } },
    };
    const o = resolveShelfOrigin(b, null);
    expect(o.changed).toBe(true);
    expect(o.x + SHELF_W).toBeLessThanOrEqual(0);
    const again = resolveShelfOrigin({ ...b, shelf: { x: o.x, y: o.y } }, null);
    expect(again, '搬到位之后就该沿用').toEqual({ x: o.x, y: o.y, changed: false });
  });

  it('架在纸上方但横向错开 → 不用搬', () => {
    const b = { shelf: { x: -900, y: 0 }, sheets: { p1: { x: 0, y: 500, w: 1600, h: 900 } } };
    expect(resolveShelfOrigin(b, null)).toEqual({ x: -900, y: 0, changed: false });
  });

  it('架在纸下方、横向重叠但纵向错开 → 不用搬', () => {
    const b = { shelf: { x: 24, y: 2000 }, sheets: { p1: { x: 0, y: 0, w: 1600, h: 900 } } };
    expect(resolveShelfOrigin(b, null)).toEqual({ x: 24, y: 2000, changed: false });
  });
});

describe('nextShelfSpot：一摞（2026-09-01）', () => {
  const origin = { x: 24, y: 24 };

  /**
   * 架从一根竖列改成一摞（站主拍板「暂存架我们干脆也就改成栈吧」）。
   * 这一族原来钉的是折列：一列一屏高、满了往左折、一件比整列高就给它一个空列。
   * 那些判据连同 SHELF_COL_H / SHELF_COL_STEP / shelfColumnX / COL_LIMIT 一起
   * 退役了 —— 一摞不需要让位，本来就是叠着的。
   */
  it('⭐ 所有货叠在原点：连码 20 件，落点一个像素都不动', () => {
    const spots = [];
    for (let i = 0; i < 20; i += 1) spots.push(nextShelfSpot(origin));
    expect(new Set(spots.map(s => `${s.x},${s.y}`)).size).toBe(1);
    expect(spots[0]).toEqual({ x: 24, y: 24 });
  });

  it('⭐ 架不再按件数长（这是改成一摞的全部理由）', () => {
    // 老行为：26 件码到 8322px 横穿四张纸（真案 proj_mtg61or1）
    let bottom = origin.y;
    for (let i = 0; i < 26; i += 1) bottom = Math.max(bottom, nextShelfSpot(origin).y);
    expect(bottom - origin.y).toBe(0);
  });

  it('原点取整（存量里有小数坐标）', () => {
    expect(nextShelfSpot({ x: 23.6, y: -0.4 })).toEqual({ x: 24, y: -0 });
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
