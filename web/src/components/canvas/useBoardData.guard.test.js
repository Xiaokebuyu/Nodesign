/** 幽灵座位闸（2026-08-29）：纯尺寸补丁不许给没座位的卡造 (0,0) 假座。 */
import { describe, it, expect } from 'vitest';
import { shouldPersistLayoutPatch } from './useBoardData.js';

describe('shouldPersistLayoutPatch', () => {
  it('没座位 + 纯尺寸补丁（测量回写）→ 拒：不造原点幽灵卡', () => {
    expect(shouldPersistLayoutPatch(undefined, { h: 628 })).toBe(false);
    expect(shouldPersistLayoutPatch(undefined, { w: 300, h: 111 })).toBe(false);
  });
  it('没座位但带坐标（新建/拖拽落点）→ 收', () => {
    expect(shouldPersistLayoutPatch(undefined, { x: 120, y: 80 })).toBe(true);
  });
  it('已有座位 → 什么补丁都收（真值回写正是为了它）', () => {
    expect(shouldPersistLayoutPatch({ x: 24, y: 216 }, { h: 148 })).toBe(true);
    expect(shouldPersistLayoutPatch({ x: 24, y: 216 }, { seat: 'user' })).toBe(true);
  });
});
