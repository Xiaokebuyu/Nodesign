/**
 * 设备档一路走到落位（2026-08-28 移动端第二轮）。
 *
 * 这条链有三段，每段坏了都不报错、只是用户手机上收到一块读不了的东西：
 *   浏览器判档 → viewpoint-store 收下 → fitFor 出版式 → resolvePlacement 排版
 * 所以判据从「服务端收到什么」量到「落位落在哪」，不在中间任何一段停。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setViewpoint, getViewpoint, describeDevice, _resetViewpoints } from '../projects/viewpoint-store.js';
import { fitFor, SKETCH_FIT } from './sketch-layout.js';
import { resolvePlacement } from './board-place.js';

const vpOf = (device) => ({
  camera: { x: 0, y: 0, w: 1600, h: 950 }, zoom: 1, ...(device ? { device } : {}),
});
const PHONE = { class: 'phone', w: 390, h: 664, dpr: 3, coarse: true };
const TABLET = { class: 'tablet', w: 810, h: 1080, dpr: 2, coarse: true };
const DESKTOP = { class: 'desktop', w: 1600, h: 950, dpr: 1, coarse: false };

describe('视点里的设备档', () => {
  beforeEach(() => _resetViewpoints());

  it('原样收下三档', () => {
    for (const d of [PHONE, TABLET, DESKTOP]) {
      setViewpoint('p', vpOf(d));
      expect(getViewpoint('p').device.class).toBe(d.class);
    }
  });

  it('认不出的档当桌面 —— 宁可给手机一份桌面版式，也别给桌面一份 342 宽的窄条', () => {
    setViewpoint('p', vpOf({ class: 'watch', w: 390, h: 664 }));
    expect(getViewpoint('p').device.class).toBe('desktop');
  });

  it('⛔ 尺寸不像真屏幕就整个丢掉 device，不是夹到边界', () => {
    // 夹持在这儿是错的判法：一个夹出来的 8000 会变成 8000 宽的版式建议
    setViewpoint('p', vpOf({ class: 'phone', w: 999999, h: 5, coarse: true }));
    expect(getViewpoint('p').device).toBe(null);
    setViewpoint('p2', vpOf({ class: 'phone', w: 'x', h: 664, coarse: true }));
    expect(getViewpoint('p2').device).toBe(null);
  });

  it('老前端不报 device 也不炸（这条链要能灰度）', () => {
    setViewpoint('p', vpOf(null));
    expect(getViewpoint('p').device).toBe(null);
    expect(fitFor(getViewpoint('p')).lane).toBe('desktop');
  });

  it('人话只在触屏档说 —— 桌面是默认情况，说了是噪音', () => {
    expect(describeDevice({ device: PHONE })).toContain('手机');
    expect(describeDevice({ device: TABLET })).toContain('平板');
    expect(describeDevice({ device: DESKTOP })).toBe(null);
    expect(describeDevice(null)).toBe(null);
  });
});

describe('fitFor 出的版式', () => {
  it('手机：一件 = 一屏，宽 = 屏宽 − 48', () => {
    const f = fitFor(vpOf(PHONE));
    expect(f.lane).toBe('phone');
    expect(f.column).toBe(true);
    expect(f.w).toBe(342);
    expect(f.screen).toEqual({ w: 390, h: 664 });
    // 高度给到 1.6 屏：竖着滚是手机上读长内容的天然姿势，宽度才是硬约束
    expect(f.h).toBe(Math.round(664 * 1.6));
  });

  it('平板同一条规矩，只是屏幕大', () => {
    const f = fitFor(vpOf(TABLET));
    expect(f.lane).toBe('tablet');
    expect(f.column).toBe(true);
    expect(f.w).toBe(762);
  });

  it('桌面一个数都没变（这一轮不许动桌面）', () => {
    const f = fitFor(vpOf(DESKTOP));
    expect(f.lane).toBe('desktop');
    expect(f.column).toBe(false);
    expect(f.w).toBe(2000);      // 1600 / 0.8
    expect(f.h).toBe(1188);      // 950 / 0.8（四舍五入）
  });

  it('⭐ 屏幕像素跟缩放无关 —— 用户缩到 0.3 倍，版式建议不该跟着变', () => {
    const zoomed = { camera: { x: 0, y: 0, w: 1300, h: 2213 }, zoom: 0.3, device: PHONE };
    expect(fitFor(zoomed).w).toBe(342);
  });

  it('没有 device 时退回相机×缩放那条老路（08-23 起就在这么算）', () => {
    expect(fitFor({ camera: { x: 0, y: 0, w: 2000, h: 1187 }, zoom: 0.8 }).w).toBe(2000);
    // 什么都没有 → SKETCH_FIT 缺省
    expect(fitFor(null).w).toBe(SKETCH_FIT.w);
    expect(fitFor(null).lane).toBe('desktop');
  });
});

describe('单列落位', () => {
  const anchor = { x: 0, y: 0, w: 342, h: 200 };
  const box = { w: 342, h: 200 };

  it('near 不挑侧，一律正下方', () => {
    const r = resolvePlacement({ box, anchor, obstacles: [anchor], column: true });
    expect(r.resolution).toBe('near-below');
    expect(r.y).toBeGreaterThanOrEqual(anchor.y + anchor.h);
  });

  it('⭐ 模型点名要 side:right 也降级成正下方 —— 并排的第二件在他屏幕外', () => {
    const r = resolvePlacement({ box, anchor, side: 'right', obstacles: [anchor], column: true });
    expect(r.resolution).toBe('near-below');
    // 对照：桌面档照旧听它的
    const desk = resolvePlacement({ box, anchor, side: 'right', obstacles: [anchor] });
    expect(desk.resolution).toBe('near-right');
  });

  it('线程接楼也不横接（replyDir 从用户摆放学来的横向偏好在单列档不算数）', () => {
    const replyTo = { x: 0, y: 0, w: 342, h: 200 };
    const r = resolvePlacement({ box, replyTo, replyDir: 'right', obstacles: [replyTo], column: true });
    expect(r.y).toBeGreaterThanOrEqual(replyTo.y + replyTo.h);
    expect(r.x).toBe(replyTo.x);
    // 对照：桌面档照旧横接
    const desk = resolvePlacement({ box, replyTo, replyDir: 'right', obstacles: [replyTo] });
    expect(desk.x).toBeGreaterThan(replyTo.x);
  });

  it('落位仍然没有失败分支（挤满了也给个位置，不抛不回 null）', () => {
    const wall = Array.from({ length: 40 }, (_, i) => ({ x: 0, y: i * 210, w: 342, h: 200 }));
    const r = resolvePlacement({ box, anchor, obstacles: wall, column: true, contentBottom: 40 * 210 });
    expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
  });
});
