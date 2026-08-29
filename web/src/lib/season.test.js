import { describe, it, expect } from 'vitest';
import { seasonOf, SKINS, hasSkin, currentSkin } from './season.js';

/**
 * 季节皮肤的三条契约。它们坏起来都很安静：
 * 换季不是报错，是**某天有人打开站点，发现界面变成了半成品**。
 */
describe('季节按月份分档', () => {
  it('北半球四季的边界月份落对', () => {
    const at = (m) => seasonOf(new Date(2026, m - 1, 15));
    expect(at(3)).toBe('spring');
    expect(at(5)).toBe('spring');
    expect(at(6)).toBe('summer');
    expect(at(8)).toBe('summer');
    expect(at(9)).toBe('autumn');
    expect(at(11)).toBe('autumn');
    expect(at(12)).toBe('winter');
    expect(at(1)).toBe('winter');
    expect(at(2)).toBe('winter');
  });

  it('一年十二个月都能落到某一季，没有空档', () => {
    for (let m = 1; m <= 12; m++) {
      expect(['spring', 'summer', 'autumn', 'winter']).toContain(seasonOf(new Date(2026, m - 1, 1)));
    }
  });
});

describe('⭐ 没做皮肤的季节，站点保持不动', () => {
  it('currentSkin 对没做的季节返回空对象（spread 上去等于没动）', () => {
    // 冬天还没做 —— 用户拍的板：「下个季节到来前还没做出冬季皮肤的话，就不动」
    expect(hasSkin('winter')).toBe(false);
    expect(currentSkin(new Date(2026, 11, 20))).toEqual({});
    expect(currentSkin(new Date(2027, 0, 10))).toEqual({});
  });

  it('空皮肤合成之后跟基线逐键相同', () => {
    const BASE = { wall: '#F0EADB', paper: '#FFFEF6', ink: '#2B2117' };
    expect({ ...BASE, ...currentSkin(new Date(2026, 11, 20)) }).toEqual(BASE);
  });
});

describe('⭐ 身份不随天气走', () => {
  // 墨、铅笔、红笔是这套语言的身份；图钉和长尾夹是物件（铜和塑料不换季）。
  // 任何一季的皮肤碰了它们，就是把「换季」做成了「换产品」。
  const FORBIDDEN = [
    'ink', 'ink2', 'pencil', 'red', 'hair', 'scrim',
    'pinA', 'pinB', 'pinRedA', 'pinRedB', 'clipA', 'clipB',
    'termA', 'termB', 'termInk', 'termDim', 'termLabel', 'termOk', 'termHair',
    'gridLine', 'index', 'trace', 'traceInk',
    'sketch', 'sketchDeep', 'sketchSoft', 'sketchNum', 'tabInk',
  ];

  for (const [name, skin] of Object.entries(SKINS)) {
    if (!skin) continue;
    it(`${name} 的皮肤没有碰身份色`, () => {
      const touched = FORBIDDEN.filter((k) => k in skin);
      expect(touched, `${name} 覆盖了不该覆盖的：${touched.join(', ')}`).toEqual([]);
    });
  }
});

describe('做了的季节确实换了纸和光', () => {
  for (const [name, skin] of Object.entries(SKINS)) {
    if (!skin) continue;
    it(`${name} 至少换了板面、纸和主光`, () => {
      for (const k of ['wall', 'paper', 'lit']) expect(skin).toHaveProperty(k);
    });

    it(`${name} 的每个值都是合法 hex`, () => {
      for (const [k, v] of Object.entries(skin)) {
        expect(v, `${name}.${k}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });
  }
});
