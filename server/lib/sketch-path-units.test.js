/**
 * path 单位单义（2026-08-30 画图探针案回归钉）。
 *
 * 真案：schema 教「d 是像素」而 at/w/h 是格 —— 同一形状两套单位，整幅画的
 * path 墨迹只有别的图元 1/24 大，agent 误诊「path 不渲染」，全场只敢用
 * rect/circle 拼，曲线全灭。判据：d 与全族同单位（格）、rect 跟墨迹走、
 * 自由 path 也过手绘抖动、同种子确定性。
 */
import { describe, it, expect } from 'vitest';
import { buildSketchShapes } from './sketch-shapes.js';
import { roughFreePath } from './sketch-layout.js';

const deps = { rectOfNode: () => null, isTaken: () => false, tag: 't' };

describe('path 的格单位与墨迹包围盒', () => {
  it('⭐ d 按格解释（×24），跟 rect/circle 同一套坐标空间', () => {
    // 同样画一个 10 格宽的东西：rect 用 w:10，path 用 d 跨 10 格 —— 两者落出来一样大
    const r = buildSketchShapes([
      { kind: 'rect', at: { x: 0, y: 0 }, w: 10, h: 10 },
      { kind: 'path', d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z' },
    ], deps);
    expect(r.error).toBeUndefined();
    const [rect, path] = r.shapes;
    expect(Math.abs(path.rect.w - rect.rect.w)).toBeLessThan(4);
    expect(Math.abs(path.rect.h - rect.rect.h)).toBeLessThan(4);
  });

  it('⭐ rect 跟墨迹走：d 从 (5,3) 格起笔，选中框就在那儿，不套住一片空气', () => {
    const r = buildSketchShapes([{ kind: 'path', d: 'M 5 3 L 8 3 L 8 6 Z' }], deps);
    const p = r.shapes[0];
    expect(p.rect.x).toBe(5 * 24 - 6);
    expect(p.rect.y).toBe(3 * 24 - 6);
    // 路径已平移到局部（最小值 ≈ pad 6）
    const nums = p.d.match(/-?\d*\.?\d+/g).map(Number);
    const xs = nums.filter((_, k) => k % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeLessThanOrEqual(8);
  });

  it('at 是额外平移（组合坐标：at + d，同为格）', () => {
    const a = buildSketchShapes([{ kind: 'path', at: { x: 10, y: 0 }, d: 'M 0 0 L 4 4' }], deps);
    expect(a.shapes[0].rect.x).toBe(10 * 24 + 0 - 6);
  });

  it('自由 path 过手绘抖动：长直线被拆成微抖折线；同种子两次结果一致', () => {
    const mk = () => buildSketchShapes([{ id: 'w1', kind: 'path', d: 'M 0 0 L 20 0' }], deps).shapes[0].d;
    const d1 = mk(); const d2 = mk();
    expect(d1).toBe(d2);                                  // 种子确定性
    expect((d1.match(/L/g) || []).length).toBeGreaterThan(3);   // 480px 直线拆成了多段
  });

  it('Q/C 曲线原样保留（曲线不抖）；Z 换成显式收笔', () => {
    const r = buildSketchShapes([{ kind: 'path', d: 'M 0 0 Q 5 5 10 0 C 12 2 14 2 16 0 Z' }], deps);
    const d = r.shapes[0].d;
    expect(d).toMatch(/Q [\d.]+ [\d.]+ [\d.]+/);
    expect(d).toMatch(/C /);
    expect(d).not.toMatch(/Z/);                           // Z 展开成抖回起点的线
  });

  it('⛔ 小写/非法命令大声拒，不静默', () => {
    const r = buildSketchShapes([{ kind: 'path', d: 'M 0 0 l 10 10' }], deps);
    expect(r.error).toMatch(/大写/);
  });
});

describe('roughFreePath', () => {
  it('端点一个不动（agent 的几何意图神圣）', () => {
    const d = roughFreePath('M 0 0 L 100 0 L 100 100', 's');
    const nums = d.match(/-?\d*\.?\d+/g).map(Number);
    // 最后一个坐标点必须还是 (100,100)
    expect(nums[nums.length - 2]).toBe(100);
    expect(nums[nums.length - 1]).toBe(100);
    expect(d.startsWith('M 0 0')).toBe(true);
  });
});
