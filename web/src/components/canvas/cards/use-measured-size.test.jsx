// @vitest-environment happy-dom
/**
 * useMeasuredSize 回写守卫（2026-09-12）：远景档卡体不渲染，根元素只剩边框那 2px，
 * 以前只挡 0 → 2px 落盘，服务端占位表里那张卡塌成 2px。现在看 data-far 且有下限。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act, useRef } from 'react';
import { useMeasuredSize } from './useMeasuredSize.js';

beforeAll(() => {
  // happy-dom 不排版：按 data-h 假装量到的高
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return Number(this.dataset.h || 0); } });
});
let host; let root;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

function Card({ o, far, h, onMeasured }) {
  const ref = useRef(null);
  useMeasuredSize(ref, o, onMeasured);
  return <div ref={ref} data-far={far ? '1' : undefined} data-h={h}><span>x</span></div>;
}
function mount(props) {
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<Card {...props} />); });
}
const o = { id: 'p.png', type: 'image', pos: { x: 0, y: 0, w: 200, h: 176 } };

describe('useMeasuredSize', () => {
  it('远景档（data-far）不回写；2px 这种不可能的高也不回写', () => {
    const a = vi.fn(); mount({ o, far: true, h: 2, onMeasured: a });
    expect(a).not.toHaveBeenCalled();
    const b = vi.fn(); mount({ o, far: false, h: 2, onMeasured: b });
    expect(b).not.toHaveBeenCalled();
  });
  it('正常档量到真高就回写', () => {
    const c = vi.fn(); mount({ o, far: false, h: 240, onMeasured: c });
    expect(c).toHaveBeenCalledWith('p.png', { h: 240 });
  });
});
