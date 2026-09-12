// @vitest-environment happy-dom
/**
 * 精灵换句子（2026-09-12 站主定）：旧句先倒序抹掉，再正向写新句，不是零帧替换。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { HandwritingSwap, eraseDurationMs } from './SpriteSketchLayer.jsx';

let host; let root;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

function mount(text) {
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<HandwritingSwap text={text} />); });
}
const spans = () => [...host.querySelectorAll('span')];

describe('HandwritingSwap', () => {
  it('换句：旧句进入抹除态（倒序、从不透明开始），抹完才换成新句正向写', () => {
    vi.useFakeTimers();
    mount('第一句');
    expect(spans().map(s => s.textContent).join('')).toBe('第一句');
    expect(spans()[0].style.animation).toMatch(/ndInkIn/);

    act(() => { root.render(<HandwritingSwap text="第二句话" />); });
    // 抹除态：还是旧句，倒序延迟（最后一个字先走）
    expect(spans().map(s => s.textContent).join('')).toBe('第一句');
    const out = spans();
    expect(out.every(s => /ndInkOut/.test(s.style.animation))).toBe(true);
    expect(out.every(s => s.style.opacity === '1')).toBe(true);
    const delayOf = (s) => parseInt(s.style.animation.match(/(\d+)ms forwards/)[1], 10);
    expect(delayOf(out[0])).toBeGreaterThan(delayOf(out[2]));

    act(() => { vi.advanceTimersByTime(eraseDurationMs('第一句')); });
    expect(spans().map(s => s.textContent).join('')).toBe('第二句话');
    expect(spans().every(s => /ndInkIn/.test(s.style.animation))).toBe(true);
    // 之后写新句不再等身体画完那 760ms：第一个字延迟 0
    expect(spans()[0].style.animation).toMatch(/\s0ms forwards/);
  });
});
