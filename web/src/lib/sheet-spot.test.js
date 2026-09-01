/**
 * 纸内局部坐标 → 世界坐标（2026-08-29 占位契约刀 C）。
 *
 * 这是流式板书"字流到真位置"的最后一环：服务端把 agent 给的 at/sheet 随正文第一拍
 * 抽出来，前端靠这个函数把它落到画布上。算错的后果不是报错，是**字画在错的地方**，
 * 所以这里连边距、纸的选择、算不出来时的退路一起钉。
 *
 * 另钉一条 parity：SHEET_MARGIN 和 CARD_MAX_H 两端各存一份，分叉了不报错。
 */
import { describe, it, expect } from 'vitest';
import { sheetSpotToWorld, SHEET_MARGIN, CARD_MAX_H } from './board-geometry.js';
import { SHEET_MARGIN as SRV_MARGIN } from '../../../server/lib/board-sheets.js';
import { CARD_MAX_H as SRV_CARD_MAX_H } from '../../../server/lib/screen.js';

const sheets = {
  p1: { x: 100, y: 200, w: 1000, h: 800, at: '2026-08-29T01:00:00Z' },
  p2: { x: 100, y: 1100, w: 1000, h: 800, at: '2026-08-29T02:00:00Z' },
};

describe('sheetSpotToWorld', () => {
  it('⭐ 点名了纸 → 落在那张纸的版心里', () => {
    expect(sheetSpotToWorld(sheets, { at: { x: 10, y: 20 }, sheet: 'p1' }))
      .toEqual({ x: 100 + SHEET_MARGIN + 10, y: 200 + SHEET_MARGIN + 20 });
  });

  it('⭐ 没点名 → 落在登记时间最新的那张（跟服务端 currentSheet 的回落一致）', () => {
    expect(sheetSpotToWorld(sheets, { at: { x: 0, y: 0 } }))
      .toEqual({ x: 100 + SHEET_MARGIN, y: 1100 + SHEET_MARGIN });
  });

  // ⚠️ 08-29 刀 F 改了这条的答案：没点名位置**不再**返回 null —— 那是顺排，
  // 前端照服务端同一条规则算得出来（见下方"顺排预测"一组）。
  it('⭐ 没有 at → 走顺排预测，不再是 null', () => {
    expect(sheetSpotToWorld(sheets, { sheet: 'p1' }, {})).toMatchObject({ flow: true });
    expect(sheetSpotToWorld(sheets, null, {})).toMatchObject({ flow: true });
    // at 只写了一半（x 有 y 没有）也当没给 —— 半截坐标绝不能拿来定位
    expect(sheetSpotToWorld(sheets, { at: { x: 1 } }, {})).toMatchObject({ flow: true });
  });

  it('⭐ 一张纸都没有 → null（别把字画到原点去）', () => {
    expect(sheetSpotToWorld({}, { at: { x: 5, y: 5 } })).toBeNull();
    expect(sheetSpotToWorld(null, { at: { x: 5, y: 5 } })).toBeNull();
  });

  it('点名了一张不存在的纸 → 回落到最新那张，不是返回 null', () => {
    expect(sheetSpotToWorld(sheets, { at: { x: 0, y: 0 }, sheet: '不存在' }))
      .toEqual({ x: 100 + SHEET_MARGIN, y: 1100 + SHEET_MARGIN });
  });
});

describe('两端常量 parity', () => {
  it('SHEET_MARGIN 与服务端一致（差一点字就整体偏一点，不报错）', () => {
    expect(SHEET_MARGIN).toBe(SRV_MARGIN);
  });
  it('CARD_MAX_H 与服务端一致（估算封顶和渲染折叠必须同一个数）', () => {
    expect(CARD_MAX_H).toBe(SRV_CARD_MAX_H);
  });
});

/**
 * 栏格预测（2026-09-01 刀 2）—— 流式预览要跟服务端落在同一个地方，否则写完还要
 * 跳一下（站主原话「填入文本完毕后就不用再二次刷新了」）。
 *
 * ⛔ 版位那一支 09-01 撤了，换成这一份：规则必须跟服务端 `nextSpotInSheet`
 * 一字不差 —— 竖着填满一栏，到底换右边一栏，整页满了返回 null（服务端会翻页，
 * 那张纸此刻还不存在）。
 */
describe('sheetSpotToWorld 栏格预测', () => {
  // 1000 宽的纸、版心 952、栏宽默认 432 → 2 栏 × 464
  const sheets = { p1: { x: 100, y: 200, w: 1000, h: 800, at: '2026-08-29T01:00:00Z', colW: 432 } };
  const inner = { x: 100 + SHEET_MARGIN, y: 200 + SHEET_MARGIN };

  it('⭐ 空纸 + 什么都没点名 → 版心左上角（这就是服务端会放的地方）', () => {
    expect(sheetSpotToWorld(sheets, {}, {})).toMatchObject({ x: inner.x, y: inner.y, flow: true, col: 0 });
  });

  it('⭐ 这一栏里已有东西 → 接最低那件往下（gap 24）', () => {
    const layout = {
      a: { x: 124, y: 224, w: 432, h: 100 },
      b: { x: 124, y: 348, w: 432, h: 60 },
    };
    expect(sheetSpotToWorld(sheets, {}, layout).y).toBe(348 + 60 + 24);
  });

  it('⭐⭐ 第一栏排到底 → 第二栏顶上（服务端会这么排，预览跟不上就等于没有预览）', () => {
    const layout = { tall: { x: 124, y: 224, w: 432, h: 760 } };   // 底 984 > 版心底 976
    const r = sheetSpotToWorld(sheets, {}, layout);
    expect(r.col).toBe(1);
    expect(r.x).toBe(inner.x + 464 + 24);
    expect(r.y).toBe(inner.y);
  });

  it('纸外的东西不算数（中心点判据）', () => {
    const layout = { far: { x: 5000, y: 5000, w: 100, h: 100 } };
    expect(sheetSpotToWorld(sheets, {}, layout).y).toBe(inner.y);
  });

  it('没量过尺寸的条目跳过 —— 宁可少算也不错算', () => {
    const layout = { noH: { x: 124, y: 400 } };
    expect(sheetSpotToWorld(sheets, {}, layout).y).toBe(inner.y);
  });

  it('⭐ 每一栏都排到底了 → null（服务端会翻下一页，那张纸还不存在）', () => {
    const layout = { tall: { x: 124, y: 224, w: 940, h: 760 } };   // 横跨两栏，且排到底
    expect(sheetSpotToWorld(sheets, {}, layout)).toBeNull();
  });

  it('⭐ 接楼（reply_to）→ 被回应那条的正下方，左缘对齐它', () => {
    const layout = { 'notes/板书/x.md': { x: 300, y: 400, w: 432, h: 80 } };
    expect(sheetSpotToWorld(sheets, { reply_to: 'notes/板书/x.md' }, layout))
      .toEqual({ x: 300, y: 400 + 80 + 24 });
  });

  it('⭐ 算不准的三种退回空地：贴放 / chain / 批内第二条起', () => {
    expect(sheetSpotToWorld(sheets, { near: 'deck:a.html', side: 'right' }, {})).toBeNull();
    expect(sheetSpotToWorld(sheets, { chain: true }, {})).toBeNull();
    expect(sheetSpotToWorld(sheets, { batchIdx: 1 }, {})).toBeNull();
    // 批内但点名了位置的照算不误
    expect(sheetSpotToWorld(sheets, { batchIdx: 2, at: { x: 0, y: 0 } }, {})).toBeTruthy();
  });
});

describe('freshSheet 预告（2026-08-30 刀④）', () => {
  // batch = [open_sheet, write]：流式时新纸还没登记。没有这一支，预览
  // 会退到「最新那张纸」（偏一整屏）或空地（叠一堆）——「都集中在一处流式」的病根。
  const sheets = { p1: { x: 24, y: 48, w: 2048, h: 973, at: '2026-08-30T10:00:00Z' } };
  const layout = { 'notes/板书/a.md': { x: 48, y: 72, w: 600, h: 300 } };

  /**
   * ⭐⭐ 2026-09-01 刀 2：新纸落在**同一块地**上。
   * 此前这里算的是「上一张内容底 + 48 沟」—— 那是 08-30「往下铺」时的规则；
   * open_sheet 的缺省 09-01 翻成「叠一页」之后，那个算法每次都把预览画到
   * 下面一屏去，比没有预览更坏。
   */
  it('⭐ freshSheet → 新纸的版心左上（同一块地，不是下面一屏）', () => {
    const r = sheetSpotToWorld(sheets, { freshSheet: true }, layout);
    expect(r).toMatchObject({ x: 24 + 24, y: 48 + 24 });
    // 对照：旧规则会算到 456+24 —— 差着一整屏
    expect(r.y).not.toBe(456 + 24);
  });

  it('空板上 freshSheet 退 null（没得预测）', () => {
    expect(sheetSpotToWorld({}, { freshSheet: true }, {})).toBeNull();
  });
});
