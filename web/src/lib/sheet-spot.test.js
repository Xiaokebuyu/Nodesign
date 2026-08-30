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
 * 版位落点（2026-08-29 刀 E）：流式预览要跟服务端落在同一个地方，否则写完还要
 * 跳一下 —— 站主原话「填入文本完毕后就不用再二次刷新了」。
 */
describe('sheetSpotToWorld 认版位', () => {
  const planned = {
    p1: {
      x: 100, y: 200, w: 1000, h: 800, at: '2026-08-29T01:00:00Z',
      slots: { main: { x: 0, y: 0, w: 432, h: 600 }, aside: { x: 460, y: 0, w: 300, h: 300 } },
    },
  };

  it('⭐ 空版位 → 落在那块地的左上角，宽度也是那块地的', () => {
    expect(sheetSpotToWorld(planned, { slot: 'main', sheet: 'p1' }))
      .toEqual({ x: 100 + SHEET_MARGIN, y: 200 + SHEET_MARGIN, w: 432 });
  });

  it('⭐ 版位里已有东西 → 接在最低那件下面（跟服务端 nextSpotInSlot 同规则）', () => {
    const layout = {
      a: { x: 124, y: 224, w: 432, h: 100 },      // 在 main 里
      b: { x: 584, y: 224, w: 300, h: 500 },      // 在 aside 里，不该影响 main
    };
    const r = sheetSpotToWorld(planned, { slot: 'main', sheet: 'p1' }, layout);
    expect(r.y).toBe(224 + 100 + SHEET_MARGIN);
  });

  it('版位名不存在 → 退回 at；两个都没有就退到顺排', () => {
    expect(sheetSpotToWorld(planned, { slot: '没有', sheet: 'p1', at: { x: 10, y: 10 } }))
      .toEqual({ x: 100 + SHEET_MARGIN + 10, y: 200 + SHEET_MARGIN + 10 });
    expect(sheetSpotToWorld(planned, { slot: '没有', sheet: 'p1' }, {})).toMatchObject({ flow: true });
  });
});

/**
 * 顺排预测（2026-08-29 刀 F）。站主看到的现象：「流式完毕之后再移动」。
 *
 * 根因不在流式通道，在**最常见的那条调用形态没有位置**：agent 只给 text 时服务端
 * 按纸内顺排落位，而前端此前无从预知，只能把字写在视口一块空地上、等落盘再跳。
 * 现在前端照服务端同一条规则（接最低那件往下）自己算。
 */
describe('sheetSpotToWorld 顺排预测', () => {
  const sheets = { p1: { x: 100, y: 200, w: 1000, h: 800, at: '2026-08-29T01:00:00Z' } };
  const inner = { x: 100 + SHEET_MARGIN, y: 200 + SHEET_MARGIN };

  it('⭐ 空纸 + 什么都没点名 → 版心左上角（这就是服务端会放的地方）', () => {
    expect(sheetSpotToWorld(sheets, {}, {})).toMatchObject({ x: inner.x, y: inner.y, flow: true });
  });

  it('⭐ 纸上已有东西 → 接最低那件往下（gap 24）', () => {
    const layout = {
      a: { x: 124, y: 224, w: 432, h: 100 },
      b: { x: 124, y: 348, w: 432, h: 60 },
    };
    expect(sheetSpotToWorld(sheets, {}, layout).y).toBe(348 + 60 + 24);
  });

  it('纸外的东西不算数（中心点判据）', () => {
    const layout = { far: { x: 5000, y: 5000, w: 100, h: 100 } };
    expect(sheetSpotToWorld(sheets, {}, layout).y).toBe(inner.y);
  });

  it('没量过尺寸的条目跳过 —— 宁可少算也不错算', () => {
    const layout = { noH: { x: 124, y: 400 } };
    expect(sheetSpotToWorld(sheets, {}, layout).y).toBe(inner.y);
  });

  it('⭐ 排到纸底了 → null（服务端会翻新纸，那张纸还不存在）', () => {
    const layout = { tall: { x: 124, y: 224, w: 432, h: 900 } };
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
