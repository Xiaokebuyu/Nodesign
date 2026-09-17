// 谱系收叠点开 / 收起的计数（09-17）：日志行的形状就是量尺，钉住字段与夹紧。
import { describe, it, expect } from 'vitest';
import { lineageToggleRecord } from './board.js';

describe('lineageToggleRecord', () => {
  it('合法请求 → 一条记录；count 取整夹到 0..999，open 只认 true', () => {
    expect(lineageToggleRecord('p1', 'u1', { tip: 'site:v3', count: 2.6, open: true }))
      .toEqual({ pid: 'p1', user: 'u1', tip: 'site:v3', count: 3, open: true });
    expect(lineageToggleRecord('p1', undefined, { tip: 'x', count: 5000, open: 'yes' }))
      .toEqual({ pid: 'p1', user: null, tip: 'x', count: 999, open: false });
    expect(lineageToggleRecord('p1', 'u1', { tip: 'x', count: -3 }).count).toBe(0);
  });
  it('没有 tip → null（路由回 400）；超长 tip 截到 300', () => {
    expect(lineageToggleRecord('p1', 'u1', {})).toBeNull();
    expect(lineageToggleRecord('p1', 'u1', { tip: 42 })).toBeNull();
    expect(lineageToggleRecord('p1', 'u1', { tip: 'a'.repeat(400) }).tip).toHaveLength(300);
  });
});
