/**
 * 纸（sheet）分配与符号地图（2026-08-29 纸范式刀 1）。
 * 判据先验：分配的每条纪律（对准视口 / 正下方续铺 / 纸不撞纸 / 没有失败分支）
 * 各配一条正反用例，别等真会话来量。
 */
import { describe, it, expect } from 'vitest';
import {
  SHEET_GAP, SHEET_MARGIN, sheetSizeFor, sheetRects, nextSheetName, sheetOfPoint,
  sheetMembers, innerRect, toWorld, toLocal, currentSheet, allocateSheetRect,
  nextSpotInSheet, sheetSummaries,
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
 * 顺排跟着纸的形状走（2026-08-29 站主拍板）：横纸报纸分栏、竖纸只往下。
 * 原来无论什么纸都只排一列 —— 一张两个屏幕宽的纸，四分之三是空的。
 */
describe('nextSpotInSheet：横纸分栏、竖纸往下', () => {
  const land = {   // 横纸 1000x800（版心 952x752）
    sheets: { p1: S(0, 0, 1000, 800) },
    objects: { 'notes/板书/a.md': { x: 24, y: 24, w: 400, h: 200 } },
  };

  it('同一栏里接着最低成员往下排，左缘 = 版心左缘', () => {
    const p = nextSpotInSheet(land, 'p1', { w: 400, h: 100 });
    expect(p.x).toBe(SHEET_MARGIN);
    expect(p.y).toBe(24 + 200 + 24);
  });

  it('⭐ 横纸：这一栏竖着装不下 → 换右边下一栏的顶上，而不是翻页', () => {
    const p = nextSpotInSheet(land, 'p1', { w: 400, h: 700 });
    expect(p).not.toBeNull();
    expect(p.col).toBe(1);
    expect(p.x).toBe(SHEET_MARGIN + 432 + 24);   // 栏宽固定 DEFAULT_CHALK_W
    expect(p.y).toBe(SHEET_MARGIN);              // 新栏从顶上开始
  });

  it('⭐ 横纸：所有栏都满了才返回 null（该翻页了）', () => {
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
    expect(p.col).toBe(0);
    expect(p.y).toBe(24 + 400 + 24);   // 第 1 栏被它压着 → 接它下面，不是挤进第 2 栏顶上
  });

  it('比纸还宽的东西没资格进', () => {
    expect(nextSpotInSheet(land, 'p1', { w: 2000, h: 100 })).toBeNull();
  });

  it('⭐ 竖纸（手机）不分栏，只往下 —— 竖屏上分栏等于把每栏挤成一指宽', () => {
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
      .toEqual({ x: SHEET_MARGIN, y: SHEET_MARGIN, col: 0 });
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
