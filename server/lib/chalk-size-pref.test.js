// 「用户喜欢多宽的板书」的学习票（2026-08-28）
//
// 两条命门：① 票源只能是前端盖的 sized:'user'（模型盖不出，也不该被别的字段冒充）
// ② 学到的值必须落在 write_on_board 的 schema 区间里 —— 学出来一个会被打回的值，
// 等于拿一个坏值顶替了一个能用的估算。
import { describe, it, expect } from 'vitest';
import { learnedChalkWidth } from './chalk-size-pref.js';

const chalk = (ts, w, extra = {}) => [`notes/板书/${ts}-x.md`, { x: 0, y: 0, w, h: 100, ...extra }];

describe('学票', () => {
  it('没人调过 → null（调用方回落按正文估）', () => {
    expect(learnedChalkWidth({ objects: {} })).toBeNull();
    expect(learnedChalkWidth(null)).toBeNull();
  });

  it('只认盖过章的：没 sized 的板书不投票', () => {
    const objects = Object.fromEntries([chalk('20260828-100000', 480)]);
    expect(learnedChalkWidth({ objects })).toBeNull();
  });

  it('一块就听它的 —— 他刚调完，下一拍就该照做', () => {
    const objects = Object.fromEntries([chalk('20260828-100000', 480, { sized: 'user' })]);
    expect(learnedChalkWidth({ objects })).toBe(20);   // 480 / 24
  });

  it('⭐ 取最近三块的中位数：一次手滑不带偏后面所有的', () => {
    const objects = Object.fromEntries([
      chalk('20260828-100000', 336, { sized: 'user' }),   // 14
      chalk('20260828-110000', 1200, { sized: 'user' }),  // 50 手滑
      chalk('20260828-120000', 360, { sized: 'user' }),   // 15
    ]);
    expect(learnedChalkWidth({ objects })).toBe(15);
  });

  it('只看最近三块，更早的调整过期', () => {
    const objects = Object.fromEntries([
      chalk('20260801-100000', 960, { sized: 'user' }),   // 40，老口味
      chalk('20260828-100000', 336, { sized: 'user' }),
      chalk('20260828-110000', 360, { sized: 'user' }),
      chalk('20260828-120000', 336, { sized: 'user' }),
    ]);
    expect(learnedChalkWidth({ objects })).toBe(14);
  });

  it('⛔ 学出界外值当没学到（schema 是 8..60）', () => {
    const objects = Object.fromEntries([chalk('20260828-100000', 24 * 200, { sized: 'user' })]);
    expect(learnedChalkWidth({ objects })).toBeNull();
  });

  it('不是板书的物件不投票（便签/产物调宽不代表板书口味）', () => {
    const objects = { 'assets/x.png': { x: 0, y: 0, w: 480, sized: 'user' } };
    expect(learnedChalkWidth({ objects })).toBeNull();
  });
});
