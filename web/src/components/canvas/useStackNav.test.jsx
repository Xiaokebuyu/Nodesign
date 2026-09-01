// @vitest-environment happy-dom
/**
 * 导航的两条契约（2026-09-01 叠纸刀 5）：
 *
 * ⭐ **翻页不动相机**，换摞才动。这是叠纸跟旧翻件器最要紧的一处差别 —— 下一页
 * 就在原地，换的是画哪一张；而"下一件"真的在别的地方，得飞过去。写错这一条的
 * 表现很轻微（画面抖一下），但它意味着两套导航被混成一套，后面每加一个功能都要
 * 在里面分叉一次。所以钉住它。
 *
 * ⭐ 板上一张叠起来的纸都没有就不出这个件（存量板照旧走 ReadingPager）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useSheetPaging } from './useSheetPaging.js';
import { useStackNav } from './useStackNav.jsx';

const STACKED = {
  p1: { x: 0, y: 0, w: 800, h: 600, at: '01', stack: 'main', title: '第一拍' },
  p2: { x: 0, y: 0, w: 800, h: 600, at: '02', stack: 'main', title: '第二拍' },
  st: { x: 900, y: 0, w: 360, h: 240, at: '03', title: '状态表' },
};
const FLAT = { a: { x: 0, y: 0, w: 800, h: 600, at: '01' }, b: { x: 0, y: 900, w: 800, h: 600, at: '02' } };

function mount(sheets, flyToBox) {
  const camApiRef = { current: { flyToBox, noteTakeover: () => {} } };
  let last = null;
  function Probe() {
    const paging = useSheetPaging({ sheets, stacks: { main: { title: '主线' } }, layout: {}, shelf: null });
    // 视口中心落在 main 那一摞里
    const camera = { viewport: { w: 400, h: 300 } };
    const cam = { x: -200, y: -150, z: 1 };
    last = { nav: useStackNav({ paging, camera, cam, camApiRef, sheets }), paging };
    return null;
  }
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<Probe />));
  return { get: () => last, unmount: () => act(() => root.unmount()) };
}

describe('叠纸导航', () => {
  it('⭐ 板上没有叠起来的摞 → 不出翻页器（存量板照旧走翻件器）', () => {
    const h = mount(FLAT, vi.fn());
    expect(h.get().nav.hasStack).toBe(false);
    expect(h.get().nav.group).toBeNull();
    h.unmount();
  });

  it('⭐ 有摞 → 出翻页器，页码跟着显示的那一页走', () => {
    const h = mount(STACKED, vi.fn());
    expect(h.get().nav.hasStack).toBe(true);
    expect(h.get().nav.group.id).toBe('stack');
    expect(h.get().nav.pile.name).toBe('main');
    expect(h.get().nav.index).toBe(1);            // 缺省显示最新那一页 = p2
    act(() => h.get().nav.flip(-1));
    expect(h.get().nav.index).toBe(0);
    h.unmount();
  });

  it('⭐⭐ 翻页一次相机都不动', () => {
    const fly = vi.fn();
    const h = mount(STACKED, fly);
    act(() => h.get().nav.flip(-1));
    act(() => h.get().nav.flip(1));
    expect(fly).not.toHaveBeenCalled();
    h.unmount();
  });

  it('⭐ 目录里点**同一摞**的另一页：翻过去，相机不动', () => {
    const fly = vi.fn();
    const h = mount(STACKED, fly);
    const main = h.get().paging.piles.find(p => p.name === 'main');
    act(() => h.get().nav.pick(main, 'p1'));
    expect(h.get().nav.index).toBe(0);
    expect(fly).not.toHaveBeenCalled();
    h.unmount();
  });

  it('⭐ 目录里点**别的摞**：翻过去，而且把镜头带过去（那是真的去别处）', () => {
    const fly = vi.fn();
    const h = mount(STACKED, fly);
    const st = h.get().paging.piles.find(p => p.name === 'st');
    act(() => h.get().nav.pick(st, 'st'));
    expect(fly).toHaveBeenCalledTimes(1);
    expect(fly.mock.calls[0][0]).toMatchObject({ x: 900, y: 0, w: 360, h: 240 });
    h.unmount();
  });

  it('视口中心不在任何一摞里时取最近的那一摞（翻页器不许变成空白）', () => {
    let last = null;
    function Probe() {
      const paging = useSheetPaging({ sheets: STACKED, stacks: {}, layout: {}, shelf: null });
      const camera = { viewport: { w: 100, h: 100 } };
      const cam = { x: -9000, y: -9000, z: 1 };   // 飞到很远的空地
      last = useStackNav({ paging, camera, cam, camApiRef: { current: {} }, sheets: STACKED });
      return null;
    }
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<Probe />));
    expect(last.pile).not.toBeNull();
    act(() => root.unmount());
  });
});
