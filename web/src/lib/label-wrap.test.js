import { describe, it, expect } from 'vitest';
import { wrapLabel } from './label-wrap.js';

describe('wrapLabel —— 线上的一句话折行', () => {
  it('短词一行', () => { expect(wrapLabel('取材')).toEqual(['取材']); });
  it('⭐ 一句话按汉字宽折，每行不超过 perLine', () => {
    const lines = wrapLabel('只拿了它的配色，字体没用，版心也是自己定的', { perLine: 10, lines: 0 });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(10);
    expect(lines.join('')).toBe('只拿了它的配色，字体没用，版心也是自己定的');
  });
  it('拉丁按 0.6 算：同样字数能放更多', () => {
    expect(wrapLabel('abcdefghijklmnop', { perLine: 10 }).length).toBe(1);
  });
  it('⭐ 平时最多 lines 行，末行以 … 收尾；lines=0 不截', () => {
    const long = '一二三四五六七八九十'.repeat(5);
    const cut = wrapLabel(long, { perLine: 10, lines: 3 });
    expect(cut.length).toBe(3); expect(cut[2].endsWith('…')).toBe(true);
    expect(wrapLabel(long, { perLine: 10, lines: 0 }).length).toBe(5);
  });
  it('空值不炸', () => { expect(wrapLabel('')).toEqual([]); expect(wrapLabel(null)).toEqual([]); });
});
