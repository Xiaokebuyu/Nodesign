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

  it('⭐ 没有 at（agent 让它顺排）→ null，调用方退回视口空地', () => {
    expect(sheetSpotToWorld(sheets, { sheet: 'p1' })).toBeNull();
    expect(sheetSpotToWorld(sheets, null)).toBeNull();
    expect(sheetSpotToWorld(sheets, { at: { x: 1 } })).toBeNull();
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
