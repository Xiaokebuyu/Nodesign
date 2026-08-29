import { describe, it, expect } from 'vitest';
import { overlaps, bboxOf, pointIn, segHitsRect } from './rect.js';

describe('segHitsRect（连线走廊判定）', () => {
  const R = { x: 100, y: 100, w: 100, h: 100 };

  it('横穿：水平线段从左到右贯穿矩形', () => {
    expect(segHitsRect({ x: 0, y: 150 }, { x: 300, y: 150 }, R)).toBe(true);
  });

  it('错过：整段在矩形上方', () => {
    expect(segHitsRect({ x: 0, y: 50 }, { x: 300, y: 50 }, R)).toBe(false);
  });

  it('斜线擦过角落外侧：不算穿', () => {
    // (0,90)→(90,0)：始终在 x+y=90 线上，离 (100,100) 的角还差得远
    expect(segHitsRect({ x: 0, y: 90 }, { x: 90, y: 0 }, R)).toBe(false);
  });

  it('斜线切进角落：算穿', () => {
    // (50,240)→(250,40) 在 x=100 处 y=190，正落在矩形 y 范围里
    expect(segHitsRect({ x: 50, y: 240 }, { x: 250, y: 40 }, R)).toBe(true);
  });

  it('端点在矩形里：算穿（线从块身上出发/落进块里都压着块）', () => {
    expect(segHitsRect({ x: 150, y: 150 }, { x: 500, y: 500 }, R)).toBe(true);
  });

  it('零长线段：点在内算穿，点在外不算', () => {
    expect(segHitsRect({ x: 150, y: 150 }, { x: 150, y: 150 }, R)).toBe(true);
    expect(segHitsRect({ x: 0, y: 0 }, { x: 0, y: 0 }, R)).toBe(false);
  });
});

describe('矩形原语基线（收敛时的契约）', () => {
  it('overlaps：贴边不算重叠，pad 是双方各让的身位', () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }, 1)).toBe(true);
  });

  it('bboxOf：空集返回 null', () => {
    expect(bboxOf([])).toBe(null);
    expect(bboxOf([{ x: 1, y: 2, w: 3, h: 4 }])).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('pointIn：含边', () => {
    expect(pointIn({ x: 10, y: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
  });
});
