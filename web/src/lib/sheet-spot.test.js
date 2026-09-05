/**
 * 流式板书的直播落点（2026-09-05 意图层：关系 → 大概坐标）。
 *
 * 服务端抽出来的 spot 只有关系（place / near / reply_to / chain），这里把它换成
 * "先把框立在锚旁边"的世界坐标。算错的后果不是报错，是字画在错的地方，所以每种
 * 关系各钉一条；算不出来必须 null（调用方退回视口空地），别把字画到原点去。
 *
 * 另钉一条 parity：CARD_MAX_H 两端各存一份，分叉了不报错；宽度三档同理。
 */
import { describe, it, expect } from 'vitest';
import { sheetSpotToWorld, CARD_MAX_H, CHALK_WIDTH_PX } from './board-geometry.js';
import { CARD_MAX_H as SRV_CARD_MAX_H } from '../../../server/lib/screen.js';
import { WIDTH_UNITS as SRV_WIDTH_UNITS } from '../../../server/engine/mcp/tools/write-on-board-schema.js';

const layout = {
  'assets/a.png': { x: 1000, y: 1000, w: 200, h: 176 },
  'notes/板书/p.md': { x: 3000, y: 3000, w: 432, h: 120, tag: '章节' },
  'notes/板书/q.md': { x: 3000, y: 3200, w: 432, h: 90, tag: '章节' },
};

describe('sheetSpotToWorld（关系 → 直播落点）', () => {
  it('⭐ place.by 贴锚：缺省右侧一格间距、顶对齐', () => {
    expect(sheetSpotToWorld(null, { place: { by: 'assets/a.png' } }, layout)).toEqual({ x: 1224, y: 1000, w: null });
  });
  it('⭐ place.side 认四向', () => {
    expect(sheetSpotToWorld(null, { place: { by: 'assets/a.png', side: 'below' } }, layout)).toMatchObject({ x: 1000, y: 1200 });
    expect(sheetSpotToWorld(null, { place: { by: 'assets/a.png', side: 'left' }, width: 'narrow' }, layout)).toMatchObject({ x: 1000 - 24 - 240, y: 1000, w: 240 });
  });
  it('near 单独给也贴着它（跟服务端"near 缺省就是落位锚"一致）', () => {
    expect(sheetSpotToWorld(null, { near: 'assets/a.png' }, layout)).toMatchObject({ x: 1224, y: 1000 });
  });
  it('⭐ reply_to 接楼：正下方、左缘对齐', () => {
    expect(sheetSpotToWorld(null, { reply_to: 'notes/板书/p.md' }, layout)).toMatchObject({ x: 3000, y: 3000 + 120 + 24 });
  });
  it('⭐ place.with 续组：同 tag 最靠下那件的正下方', () => {
    expect(sheetSpotToWorld(null, { place: { with: '章节' } }, layout)).toMatchObject({ x: 3000, y: 3200 + 90 + 24 });
  });
  it('算不出来必须 null：view / user / chain / 批内第二条 / 锚不在板上 / 没有 spot', () => {
    expect(sheetSpotToWorld(null, { place: { by: 'view' } }, layout)).toBeNull();
    expect(sheetSpotToWorld(null, { place: { by: 'user' } }, layout)).toBeNull();
    expect(sheetSpotToWorld(null, { chain: true, place: { by: 'assets/a.png' } }, layout)).toBeNull();
    expect(sheetSpotToWorld(null, { place: { by: 'assets/a.png' }, batchIdx: 1 }, layout)).toBeNull();
    expect(sheetSpotToWorld(null, { place: { by: '虚空' } }, layout)).toBeNull();
    expect(sheetSpotToWorld(null, null, layout)).toBeNull();
  });
});

describe('两端常量 parity', () => {
  it('CARD_MAX_H 与服务端一致（估算封顶和渲染折叠必须同一个数）', () => {
    expect(CARD_MAX_H).toBe(SRV_CARD_MAX_H);
  });
  it('宽度三档与服务端一致', () => {
    for (const k of Object.keys(SRV_WIDTH_UNITS)) expect(CHALK_WIDTH_PX[k]).toBe(SRV_WIDTH_UNITS[k] * 24);
  });
});
