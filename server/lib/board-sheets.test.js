/**
 * 纸（sheet）分配与符号地图（2026-08-29 纸范式刀 1）。
 * 判据先验：分配的每条纪律（对准视口 / 正下方续铺 / 纸不撞纸 / 没有失败分支）
 * 各配一条正反用例，别等真会话来量。
 */
import { describe, it, expect } from 'vitest';
import {
  SHEET_GAP, SHEET_MARGIN, sheetSizeFor, sheetRects, nextSheetName, sheetOfPoint,
  sheetMembers, innerRect, toWorld, toLocal, currentSheet, allocateSheetRect,
  nextSpotInSheet, sheetSummaries, sheetColumns, columnX, freeColumnsInSheet,
} from './board-sheets.js';
import { ONE_SCREEN } from './screen.js';

const S = (x, y, w = 1867, h = 1200, extra = {}) => ({ x, y, w, h, ...extra });

describe('纸的注册表基础', () => {
  it('sheetSizeFor：有 fit 用 fit，没有兜底一屏（0.75 基准）', () => {
    expect(sheetSizeFor({ w: 2133, h: 1267 })).toEqual({ w: 2133, h: 1267 });
    expect(sheetSizeFor(null)).toEqual(ONE_SCREEN);
    expect(ONE_SCREEN).toEqual({ w: 1867, h: 1200 });   // 1400×900 ÷ 0.75
  });

  it('纸名 ASCII 顺号：p1 起，撕掉的号不复用', () => {
    expect(nextSheetName({ sheets: {} })).toBe('p1');
    expect(nextSheetName({ sheets: { p1: S(0, 0), p3: S(0, 2000) } })).toBe('p4');
    expect(nextSheetName(null)).toBe('p1');
  });

  it('阅读序：先上后下、同带先左后右', () => {
    const b = { sheets: { a: S(2000, 0), b: S(0, 0), c: S(0, 1300) } };
    expect(sheetRects(b).map(s => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('局部坐标往返：toWorld/toLocal 互逆，原点 = 版心左上', () => {
    const s = S(100, 200);
    expect(toWorld(s, { x: 0, y: 0 })).toEqual({ x: 100 + SHEET_MARGIN, y: 200 + SHEET_MARGIN });
    expect(toLocal(s, toWorld(s, { x: 33, y: 44 }))).toEqual({ x: 33, y: 44 });
  });

  it('currentSheet：指过的还在就认，否则取登记最新', () => {
    const b = { sheets: { p1: S(0, 0, 1867, 1200, { at: '2026-08-29T01:00:00Z' }), p2: S(0, 1300, 1867, 1200, { at: '2026-08-29T02:00:00Z' }) } };
    expect(currentSheet(b, 'p1').id).toBe('p1');
    expect(currentSheet(b, '不存在').id).toBe('p2');
    expect(currentSheet(b, null).id).toBe('p2');
    expect(currentSheet({ sheets: {} })).toBeNull();
  });
});

describe('纸的成员（几何派生，不存成员表）', () => {
  const board = {
    sheets: { p1: S(0, 0, 1000, 800) },
    objects: {
      'notes/板书/a.md': { x: 100, y: 100, w: 400, h: 200 },      // 中心 (300,200) 在纸内
      'notes/板书/b.md': { x: 900, y: 700, w: 400, h: 300 },      // 中心 (1100,850) 在纸外
      'text:c': { x: 200, y: 500, w: 100, h: 40, kind: 'text', data: { t: 'x' } },
    },
  };
  it('中心点在纸内才算成员；拖出去就不是（用户的手不受纸约束）', () => {
    expect(sheetMembers(board, 'p1').map(m => m.id)).toEqual(['notes/板书/a.md', 'text:c']);
  });
  it('sheetOfPoint 命中', () => {
    expect(sheetOfPoint(board, { x: 500, y: 400 }).id).toBe('p1');
    expect(sheetOfPoint(board, { x: 5000, y: 5000 })).toBeNull();
  });
});

describe('allocateSheetRect：分配纪律', () => {
  it('铺第一张对准用户视口（snap 到格）', () => {
    const r = allocateSheetRect({ board: {}, size: { w: 1867, h: 1200 }, viewport: { x: 103, y: 207, w: 1400, h: 900 } });
    expect(r.basis).toBe('viewport');
    expect(r.x % 24).toBe(0);
    expect(Math.abs(r.x - 103)).toBeLessThanOrEqual(24);
    expect(r.overlapsLoose).toBe(false);
  });

  it('续铺缺省落在锚定纸正下方，隔一条沟', () => {
    const board = { sheets: { p1: S(0, 0) } };
    const r = allocateSheetRect({ board, size: { w: 1867, h: 1200 }, nearSheet: 'p1' });
    expect(r.basis).toBe('below-sheet');
    expect(r.x).toBe(0);
    expect(r.y).toBe(1200 + SHEET_GAP);
  });

  it('纸不撞纸（硬约束）：理想位被占沿 y 滑开', () => {
    const board = { sheets: { p1: S(0, 0), p2: S(0, 1200 + SHEET_GAP) } };
    const r = allocateSheetRect({ board, size: { w: 1867, h: 1200 }, nearSheet: 'p1' });
    const rects = sheetRects(board);
    for (const s of rects) {
      expect(r.y >= s.y + s.h || r.y + r.h <= s.y || r.x >= s.x + s.w || r.x + r.w <= s.x).toBe(true);
    }
  });

  it('散件避不开就压上并如实标 overlapsLoose（纸在物件层之下，不硬拒）', () => {
    // 理想列往下 4 屏全被散件占满 → 接受压上
    const obstacles = [];
    for (let y = 0; y < 1200 * 6; y += 100) obstacles.push({ x: 0, y, w: 2000, h: 90 });
    const r = allocateSheetRect({ board: {}, size: { w: 1867, h: 1200 }, viewport: { x: 0, y: 0, w: 1400, h: 900 }, obstacles });
    expect(r.overlapsLoose).toBe(true);
    expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);   // 没有失败分支
  });

  it('没有视口也没有锚：落在现有内容底下', () => {
    const r = allocateSheetRect({ board: { sheets: { p1: S(0, 0) } }, size: { w: 1867, h: 1200 } });
    expect(r.basis).toBe('below-content');
    expect(r.y).toBeGreaterThanOrEqual(1200);
  });
});

/**
 * 栏格（2026-09-01 刀 2）：版位退役之后，纸内怎么排**全归机器**。
 * 判据钉的是站主那句「文本的阅读本来就是从左到右从上到下」的执行形状：
 * 竖着填满一栏 → 右边下一栏 → 整页满了（由调用方翻页）。
 */
describe('sheetColumns：版心切成几栏，余量均摊', () => {
  it('⭐ 栏宽是均摊出来的，不是切死 432 —— 切死的话右边永远空一截', () => {
    const c = sheetColumns(S(0, 0, 1000, 800));      // 版心 952
    expect(c.n).toBe(2);
    expect(c.colW).toBe(464);                        // (952-24)/2，不是 432
    expect(columnX(c, 0)).toBe(24);
    expect(columnX(c, 1)).toBe(24 + 464 + 24);
    // 均摊之后两栏加一条沟正好铺满版心（这是「均摊」的定义，攻它改 colW 就红）
    expect(c.colW * c.n + c.gap * (c.n - 1)).toBe(952);
  });

  it('⭐ 纸自己的 colW 决定切几栏（手机 342 → 一张 780 的纸切两栏）', () => {
    const phone = sheetColumns(S(0, 0, 780, 1688, { colW: 342 }));
    expect(phone.n).toBe(2);
    expect(phone.colW).toBe(354);
    // 对照：同一张纸不带 colW（存量的纸）走默认 432 → 只有一栏
    expect(sheetColumns(S(0, 0, 780, 1688)).n).toBe(1);
  });

  it('窄纸至少一栏（贴着产物的小说明纸）', () => {
    const c = sheetColumns(S(0, 0, 300, 400));
    expect(c.n).toBe(1);
    expect(c.colW).toBe(252);
  });
});

describe('nextSpotInSheet：竖着填满一栏，到底换下一栏', () => {
  const land = {   // 横纸 1000x800（版心 952x752）
    sheets: { p1: S(0, 0, 1000, 800) },
    objects: { 'notes/板书/a.md': { x: 24, y: 24, w: 400, h: 200 } },
  };

  it('同一栏里接着最低成员往下排，左缘 = 版心左缘', () => {
    const p = nextSpotInSheet(land, 'p1', { w: 400, h: 100 });
    expect(p.x).toBe(SHEET_MARGIN);
    expect(p.y).toBe(24 + 200 + 24);
  });

  it('⭐ 这一栏到底了 → 下一栏的顶上（落在栏格上，不是贴着上一件的右边）', () => {
    const p = nextSpotInSheet(land, 'p1', { w: 400, h: 700 });
    expect(p).not.toBeNull();
    expect(p.moved).toBe(true);
    expect(p.col).toBe(1);
    // ⭐ 栏格是切死的：不是 24+400+24=448（跟着上一件的宽度走），而是第 2 栏的左缘。
    // 攻这一条就是把 nextSpotInSheet 换回按 box.w 步进 —— 当场差 64px。
    expect(p.x).toBe(columnX(sheetColumns(S(0, 0, 1000, 800)), 1));
    expect(p.x).toBe(512);
    expect(p.y).toBe(SHEET_MARGIN);              // 新的一栏从顶上开始
  });

  it('⭐ 纸上哪儿都放不下了才返回 null —— 这才叫满（一列到底不算）', () => {
    const full = {
      sheets: { p1: S(0, 0, 1000, 800) },
      objects: {
        a: { x: 24, y: 24, w: 900, h: 700 },     // 横跨所有栏，整页压死
      },
    };
    expect(nextSpotInSheet(full, 'p1', { w: 400, h: 200 })).toBeNull();
  });

  it('⭐ 宽物件挡住它真正盖住的那几栏（判据是水平重叠，不是中心点）', () => {
    const wide = {
      sheets: { p1: S(0, 0, 1000, 800) },
      objects: { deck: { x: 24, y: 24, w: 640, h: 400 } },   // 中心在第 1 栏，身子压到第 2 栏
    };
    const p = nextSpotInSheet(wide, 'p1', { w: 432, h: 100 });
    expect(p.moved).toBe(false);
    expect(p.y).toBe(24 + 400 + 24);   // 被它压着 → 接它下面，不是从它右边挤上去
  });

  it('比纸还宽的东西没资格进', () => {
    expect(nextSpotInSheet(land, 'p1', { w: 2000, h: 100 })).toBeNull();
  });

  it('窄纸只有一栏，只往下（一栏装不下就是装不下，没有别的栏可换）', () => {
    const port = {
      sheets: { p1: S(0, 0, 500, 1400) },
      objects: { a: { x: 24, y: 24, w: 400, h: 200 } },
    };
    // 版心 452x1352，已占到 y=224 —— 再来 1200 高就出底了
    const p = nextSpotInSheet(port, 'p1', { w: 400, h: 1200 });
    expect(p).toBeNull();                     // 装不下就是装不下，不换栏
    const q = nextSpotInSheet(port, 'p1', { w: 400, h: 100 });
    expect(q.x).toBe(SHEET_MARGIN);
    expect(q.y).toBe(24 + 200 + 24);
  });

  it('空纸从版心顶端排', () => {
    const b2 = { sheets: { p1: S(0, 0, 1000, 800) }, objects: {} };
    expect(nextSpotInSheet(b2, 'p1', { w: 400, h: 100 }))
      .toEqual({ x: SHEET_MARGIN, y: SHEET_MARGIN, col: 0, moved: false });
  });

  it('⭐ 比一栏宽的东西占掉它压住的那几栏（640 的卡在 464 的栏上要两栏）', () => {
    const b2 = { sheets: { p1: S(0, 0, 1000, 800) }, objects: {} };
    const p = nextSpotInSheet(b2, 'p1', { w: 640, h: 100 });
    expect(p.col).toBe(0);
    // 对照：它占了两栏，所以第二件 640 的卡就没地方并排了，只能接在它下面
    const b3 = { sheets: { p1: S(0, 0, 1000, 800) }, objects: { deck: { x: 24, y: 24, w: 640, h: 100 } } };
    expect(nextSpotInSheet(b3, 'p1', { w: 640, h: 100 })).toMatchObject({ col: 0, y: 148 });
  });

  it('freeColumnsInSheet 报的是同一套栏（报的和排的必须是一套）', () => {
    const free = freeColumnsInSheet(land, 'p1');
    expect(free).toHaveLength(2);
    expect(free[0].x).toBe(0);                 // 纸内局部像素
    expect(free[1].x).toBe(488);               // 512 - 24
    expect(free[0].freeH).toBeLessThan(free[1].freeH);   // 第一栏被 a.md 吃掉一截
  });
});

describe('sheetSummaries 符号地图', () => {
  it('报件数与剩余高度', () => {
    const board = {
      sheets: { p1: S(0, 0, 1000, 800, { at: '2026-08-29T01:00:00Z', title: '第一章' }) },
      objects: { 'notes/板书/a.md': { x: 24, y: 24, w: 400, h: 200 } },
    };
    const [s] = sheetSummaries(board);
    expect(s.id).toBe('p1');
    expect(s.count).toBe(1);
    expect(s.title).toBe('第一章');
    expect(s.freeH).toBe(800 - SHEET_MARGIN - (24 + 200));
    expect(innerRect(S(0, 0, 1000, 800)).w).toBe(1000 - SHEET_MARGIN * 2);
  });
});
