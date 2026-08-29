import { describe, it, expect } from 'vitest';
import { classifyDevice, isTouchLane, PHONE, TABLET, DESKTOP } from './device-class.js';

describe('设备档位', () => {
  it('没有粗指针一律是桌面 —— 窄窗口不算手机', () => {
    expect(classifyDevice({ w: 1600, h: 950, coarse: false })).toBe(DESKTOP);
    // 把浏览器窗口拖成一条：版面确实窄了，但那是 NARROW 那条判据的事，不是手机
    expect(classifyDevice({ w: 420, h: 900, coarse: false })).toBe(DESKTOP);
  });

  it('手机竖着横着都是手机（判据用短边，所以跟转屏无关）', () => {
    expect(classifyDevice({ w: 390, h: 664, coarse: true })).toBe(PHONE);   // iPhone 13 竖
    expect(classifyDevice({ w: 664, h: 390, coarse: true })).toBe(PHONE);   // 同一台横过来
    expect(classifyDevice({ w: 320, h: 568, coarse: true })).toBe(PHONE);   // iPhone SE
    expect(classifyDevice({ w: 412, h: 839, coarse: true })).toBe(PHONE);   // Pixel 7
  });

  it('平板竖着横着都是平板', () => {
    expect(classifyDevice({ w: 810, h: 1080, coarse: true })).toBe(TABLET);  // iPad gen7 竖
    expect(classifyDevice({ w: 1080, h: 810, coarse: true })).toBe(TABLET);  // 横
    expect(classifyDevice({ w: 834, h: 1194, coarse: true })).toBe(TABLET);  // iPad Pro 11
  });

  it('平板分屏成一条窄栏 → 判成手机（那就是个手机版面）', () => {
    expect(classifyDevice({ w: 320, h: 1080, coarse: true })).toBe(PHONE);
  });

  it('两条触屏档都算「不是桌面」', () => {
    expect(isTouchLane(PHONE)).toBe(true);
    expect(isTouchLane(TABLET)).toBe(true);
    expect(isTouchLane(DESKTOP)).toBe(false);
  });

  it('尺寸缺失不炸（SSR / 还没量到）', () => {
    expect(classifyDevice({ coarse: false })).toBe(DESKTOP);
    expect(classifyDevice({ coarse: true })).toBe(PHONE);
  });
});
