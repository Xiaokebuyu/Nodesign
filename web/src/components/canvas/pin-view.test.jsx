// @vitest-environment happy-dom
/**
 * 钉住视区（2026-09-01 叠纸刀 6）的三条契约。
 *
 * 「钉住」这三个字对用户的承诺就是**别把我甩走**。三条判据都是从这句话推出来的：
 *   ① 钉住时 agent 落笔不再抢镜头（否则这颗开关按了没用）
 *   ② 钉住不是不许动 —— 摞换了才飞一次，同一摞里翻页不飞（每帧框住等于把缩放也夺走）
 *   ③ 哪一轴上没有可平移的量，哪一轴的滑动才归导航（放大读细节时手势全还给平移）
 */
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { navAxes } from '../../lib/board-paging.js';
import { useSheetPaging } from './useSheetPaging.js';
import { useStackNav } from './useStackNav.jsx';
import { useBlackboardMode } from './useBlackboardMode.js';

const SHEETS = {
  p1: { x: 0, y: 0, w: 800, h: 600, at: '01', stack: 'main' },
  p2: { x: 0, y: 0, w: 800, h: 600, at: '02', stack: 'main' },
  st: { x: 900, y: 0, w: 360, h: 240, at: '03' },
};

function mount({ pinned, z = 1 }) {
  const fly = vi.fn();
  const camApiRef = { current: { flyToBox: fly, noteTakeover: () => {} } };
  let last = null;
  function Probe() {
    const paging = useSheetPaging({ sheets: SHEETS, stacks: {}, layout: {}, shelf: null });
    const camera = { viewport: { w: 400, h: 300 } };
    const cam = { x: -200, y: -150, z };
    last = useStackNav({ paging, camera, cam, camApiRef, sheets: SHEETS, pinned, paneRef: null });
    return null;
  }
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<Probe />));
  return { get: () => last, fly, unmount: () => act(() => root.unmount()) };
}

describe('⭐ 哪一轴归导航：看那一轴上还有没有可平移的量', () => {
  const pile = { w: 800, h: 600 };
  it('整摞在两轴上都进了视口 → 两轴都归导航（横滑换摞、竖滑翻页）', () => {
    expect(navAxes(pile, { w: 800, h: 600 })).toEqual({ x: true, y: true });
    expect(navAxes(pile, { w: 1600, h: 1200 })).toEqual({ x: true, y: true });
  });

  it('⭐ 放大到读细节 → 两轴都还给平移（手势不该在这时候抢）', () => {
    expect(navAxes(pile, { w: 400, h: 300 })).toEqual({ x: false, y: false });
  });

  it('一轴装得下一轴装不下 → 只有装得下那一轴归导航', () => {
    expect(navAxes(pile, { w: 900, h: 300 })).toEqual({ x: true, y: false });
    expect(navAxes(pile, { w: 400, h: 900 })).toEqual({ x: false, y: true });
  });

  it('没有摞 / 没有视口时一轴都不归导航（宁可不响应，也别乱翻）', () => {
    expect(navAxes(null, { w: 800, h: 600 })).toEqual({ x: false, y: false });
    expect(navAxes(pile, null)).toEqual({ x: false, y: false });
  });
});

describe('⭐ 钉住之后镜头怎么走', () => {
  it('刚钉上 → 框住当前这一摞（那是"钉"这个动作的全部内容）', () => {
    const h = mount({ pinned: true });
    expect(h.fly).toHaveBeenCalledTimes(1);
    expect(h.fly.mock.calls[0][0]).toMatchObject({ x: 0, y: 0, w: 800, h: 600 });
    h.unmount();
  });

  it('⭐⭐ 钉住时同一摞里翻页**不再飞** —— 钉住不是不许动，每帧框住等于把缩放也夺走', () => {
    const h = mount({ pinned: true });
    h.fly.mockClear();
    act(() => h.get().flip(-1));
    act(() => h.get().flip(1));
    expect(h.fly).not.toHaveBeenCalled();
    h.unmount();
  });

  it('没钉住 → 一次都不飞（这颗开关是唯一的入口）', () => {
    const h = mount({ pinned: false });
    expect(h.fly).not.toHaveBeenCalled();
    h.unmount();
  });

  it('钉住时手势判据按当前缩放算：贴脸看的时候两轴都不归导航', () => {
    const near = mount({ pinned: true, z: 4 });   // 视口世界宽 100 < 摞宽 800
    expect(near.get().axesRef.current).toEqual({ x: false, y: false });
    near.unmount();
    const far = mount({ pinned: true, z: 0.25 }); // 视口世界宽 1600 > 摞宽 800
    expect(far.get().axesRef.current).toEqual({ x: true, y: true });
    far.unmount();
  });
});

describe('⭐⭐ 钉住时 agent 落笔不再抢镜头', () => {
  /**
   * 这是「钉住」对用户的核心承诺。黑板模式默认开着，它原来的行为是 agent 一落笔
   * 就 flyToBox 追过去 —— 那在没钉住时是对的（不然用户不知道东西写在哪），钉住之后
   * 就正好相反了：他明说了不要被甩走。
   */
  function focusProbe({ pinned, rect }) {
    const fly = vi.fn();
    // camRef 里 cam/viewport 让「在不在视野内」算得出来：这块 rect 在视野外
    const camRef = { current: { flyToBox: fly, cam: { x: 0, y: 0, z: 1 }, viewport: { w: 400, h: 300 } } };
    function Probe() {
      useBlackboardMode({
        projectId: null, camRef, pinned,
        focusRequest: { rect, at: Date.now(), soft: false, chalk: true },
      });
      return null;
    }
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<Probe />));
    act(() => root.unmount());
    return fly;
  }

  const FAR = { x: 5000, y: 5000, w: 400, h: 200 };

  it('没钉住 → 照旧飞过去（不然用户不知道 agent 写在哪）', () => {
    expect(focusProbe({ pinned: false, rect: FAR })).toHaveBeenCalled();
  });

  it('⭐ 钉住 → 一次都不飞（改成一条带「看一眼」的提示，去不去他自己定）', () => {
    expect(focusProbe({ pinned: true, rect: FAR })).not.toHaveBeenCalled();
  });
});
