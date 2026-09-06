import { describe, it, expect } from 'vitest';
import { resolveWindowBounds, DEFAULT_SIZE } from './window-state.js';

const LAPTOP = { x: 0, y: 0, width: 1536, height: 816 };   // 1920×1080 @125%，任务栏 48
const BIG = { x: 1536, y: 0, width: 2560, height: 1400 };

describe('resolveWindowBounds', () => {
  it('首次：默认 1440×900 按主屏工作区裁（09-07 站主的底部被切就是没裁）', () => {
    const b = resolveWindowBounds(null, [LAPTOP]);
    expect(b).toEqual({ width: 1440, height: 816, maximized: false });
    expect(b.x).toBeUndefined();   // 没位置 → 居中
  });
  it('大屏放得下就是默认尺寸', () => {
    expect(resolveWindowBounds(null, [BIG])).toMatchObject(DEFAULT_SIZE);
  });
  it('记住的位置在某块屏上就照开；尺寸按那块屏裁，越界往回挪', () => {
    const b = resolveWindowBounds({ x: 1600, y: 100, width: 2000, height: 1300, maximized: true }, [LAPTOP, BIG]);
    expect(b).toEqual({ x: 1600, y: 100, width: 2000, height: 1300, maximized: true });
    const c = resolveWindowBounds({ x: 3000, y: 900, width: 2000, height: 1300 }, [LAPTOP, BIG]);
    expect(c.x + c.width).toBe(BIG.x + BIG.width);
    expect(c.y + c.height).toBe(BIG.y + BIG.height);
  });
  it('外接屏拔了：记住的位置不在任何屏上 → 丢掉位置回主屏居中，尺寸按主屏裁', () => {
    const b = resolveWindowBounds({ x: 1600, y: 100, width: 2000, height: 1300 }, [LAPTOP]);
    expect(b).toEqual({ width: 1536, height: 816, maximized: false });
  });
  it('存了个坏值（0 / NaN）→ 当没存', () => {
    expect(resolveWindowBounds({ width: 0, height: NaN, x: 'a' }, [LAPTOP])).toEqual({ width: 1440, height: 816, maximized: false });
  });
});
