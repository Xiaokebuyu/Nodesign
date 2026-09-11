import { describe, it, expect } from 'vitest';
import { wallWeek, wallRun } from './wall-date.js';

describe('登录墙的周次', () => {
  it('按几号算第几周', () => {
    expect(wallWeek(0, new Date(2026, 8, 12))).toBe('九月第二周');
    expect(wallWeek(0, new Date(2026, 8, 1))).toBe('九月第一周');
    expect(wallWeek(0, new Date(2026, 9, 31))).toBe('十月第五周');
  });
  it('往回退几周会跨月', () => {
    expect(wallWeek(2, new Date(2026, 8, 12))).toBe('八月第五周');   // 8 月 29 日
    expect(wallWeek(1, new Date(2026, 0, 3))).toBe('十二月第四周');
  });
  it('小票编号跟着同一天走', () => {
    expect(wallRun(2, '17', new Date(2026, 8, 12))).toBe('RUN 0829-17');
    expect(wallRun(0, '06', new Date(2026, 8, 12))).toBe('RUN 0912-06');
  });
});
