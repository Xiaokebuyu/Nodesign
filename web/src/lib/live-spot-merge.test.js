import { describe, it, expect } from 'vitest';
import { mergeLiveSpot } from '../components/canvas/use-live-chalk-spots.js';

describe('直播框落点：服务端预解算盖过前端近似', () => {
  it('solved 到了就换成真落点（placed + hMin），只升级一次', () => {
    const approx = { x: 1, y: 2, placed: true, w: 336, hMin: null };
    const solved = { near: 'a', solved: { x: 100, y: 200, w: 336, h: 150 } };
    const up = mergeLiveSpot(approx, solved);
    expect(up).toEqual({ x: 100, y: 200, w: 336, hMin: 150, placed: true, solved: true });
    expect(mergeLiveSpot(up, { near: 'a', solved: { x: 999, y: 999, w: 1, h: 1 } })).toBe(up);
    expect(mergeLiveSpot(approx, { near: 'a' })).toBe(approx);
    expect(mergeLiveSpot(undefined, { near: 'a' })).toBeUndefined();
  });
});
