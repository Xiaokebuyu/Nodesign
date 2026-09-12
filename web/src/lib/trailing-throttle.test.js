import { describe, it, expect, vi } from 'vitest';
import { trailingThrottle } from './trailing-throttle.js';

describe('trailingThrottle', () => {
  it('窗口内头一条立刻，其余合成末尾一条', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = trailingThrottle(fn, 4000);
    t(); t(); t();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3999);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4000);
    t();
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
