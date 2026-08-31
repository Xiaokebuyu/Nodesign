// @vitest-environment happy-dom
/**
 * 键盘覆盖模式的两半（2026-08-31）。
 *
 * 上半：`interactive-widget=resizes-visual` —— 键盘弹出时只缩视觉视口，
 *       布局视口和 dvh 一个像素不动，页面不重排。这是 Chrome 108 起安卓的默认、
 *       也是 iOS Safari 一直以来的行为，写进 meta 是为了钉住而不是改。
 * 下半：⛔ 页面因此**完全不知道谁被盖住了**，而 body 又是 position: fixed
 *       （治输入框那条橡皮筋时钉死的），浏览器没法再替我们滚。所以得自己抬。
 *
 * 这个文件测的是"自己抬"那半：inset 算得对不对、抽屉抬没抬、被压住的框滚没滚。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useKeyboardInset, useKeepFocusAboveKeyboard } from './use-keyboard-inset.js';

const LAYOUT_H = 844;

/** 假的 visualViewport：happy-dom 没有，而它正是这套东西唯一的信息来源 */
function installViewport() {
  const listeners = { resize: [], scroll: [] };
  const vv = {
    height: LAYOUT_H, offsetTop: 0,
    addEventListener: (t, f) => listeners[t]?.push(f),
    removeEventListener: (t, f) => { const a = listeners[t]; const i = a?.indexOf(f); if (i > -1) a.splice(i, 1); },
  };
  window.visualViewport = vv;
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => LAYOUT_H });
  /**
   * ⚠️ 这个假 rAF **必须是异步的**。第一版我图省事写成同步立即执行 ——
   * 于是 `raf = requestAnimationFrame(read)` 这一行里，read 先跑完、
   * 赋值才发生，`raf` 停在非 0，之后每一次 schedule 都被自己的去重闸挡掉，
   * 表现为「键盘收回去了 inset 还是 330」。**那是量具不真，不是 hook 有问题**
   * （真浏览器里 rAF 一定跨帧，赋值先于回调）。
   */
  const frames = [];
  window.requestAnimationFrame = (fn) => frames.push(fn);
  window.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
  const flush = () => { const q = frames.splice(0); q.forEach(f => f && f()); };
  return {
    flush,
    /** 键盘顶上来 h 像素 */
    keyboard(h) {
      vv.height = LAYOUT_H - h;
      act(() => { listeners.resize.forEach(f => f()); flush(); });
    },
  };
}
afterEach(() => { delete window.visualViewport; });

function Probe() {
  const { inset, visibleH } = useKeyboardInset();
  return <div data-out={`${inset}/${visibleH}`} />;
}
function mount(node) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  return { host, out: () => host.querySelector('[data-out]')?.getAttribute('data-out'),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); } };
}

describe('量键盘盖住了多少', () => {
  let vp;
  beforeEach(() => { vp = installViewport(); });

  it('没键盘时 inset = 0，可见高 = 布局视口高', () => {
    const m = mount(<Probe />);
    expect(m.out()).toBe(`0/${LAYOUT_H}`);
    m.unmount();
  });

  it('键盘顶上来 330，inset 就是 330，可见高跟着少 330', () => {
    const m = mount(<Probe />);
    vp.keyboard(330);
    expect(m.out()).toBe(`330/${LAYOUT_H - 330}`);
    m.unmount();
  });

  it('⚠️ 低于 80px 一律当没键盘 —— 地址栏收展和四舍五入不许被读成键盘', () => {
    const m = mount(<Probe />);
    vp.keyboard(40);
    expect(m.out(), '40px 被当成键盘了，一路滚动都会误判').toBe(`0/${LAYOUT_H}`);
    vp.keyboard(0);
    expect(m.out()).toBe(`0/${LAYOUT_H}`);
    m.unmount();
  });

  it('键盘收回去要归零（只上不下的话抽屉会一直吊在半空）', () => {
    const m = mount(<Probe />);
    vp.keyboard(330);
    expect(m.out()).toBe(`330/${LAYOUT_H - 330}`);
    vp.keyboard(0);
    expect(m.out()).toBe(`0/${LAYOUT_H}`);
    m.unmount();
  });
});

describe('被键盘压住的输入框自己滚出来', () => {
  let vp;
  beforeEach(() => { vp = installViewport(); });

  /** 一个能滚的祖先 + 一个输入框，输入框的位置由测试指定 */
  function scene(inputBottom) {
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 800 });
    scroller.style.overflowY = 'auto';
    scroller.scrollTop = 0;
    const input = document.createElement('input');
    input.getBoundingClientRect = () => ({ bottom: inputBottom, top: inputBottom - 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: inputBottom - 40 });
    scroller.appendChild(input);
    document.body.appendChild(scroller);
    input.focus();
    return { scroller, input, cleanup: () => scroller.remove() };
  }

  function Host({ inset }) { useKeepFocusAboveKeyboard(inset); return <div data-out="x" />; }

  it('框在键盘底下 → 滚动祖先往下推，正好把它露出来', async () => {
    const s = scene(700);                       // 键盘顶在 844-330=514，框底 700，被压住 186+12
    const m = mount(<Host inset={330} />);
    await act(async () => { await new Promise(r => setTimeout(r, 260)); });
    expect(s.scroller.scrollTop, '被压住了却没滚').toBe(700 - (LAYOUT_H - 330 - 12));
    m.unmount(); s.cleanup();
  });

  it('⛔ 框本来就在视野里 → 一个像素都不许动', async () => {
    const s = scene(300);
    const m = mount(<Host inset={330} />);
    await act(async () => { await new Promise(r => setTimeout(r, 260)); });
    expect(s.scroller.scrollTop, '没被压住还乱滚，每次弹键盘页面都会自己动一下').toBe(0);
    m.unmount(); s.cleanup();
  });

  /**
   * ⚠️ 这条第一版写的是 scene(700)，**攻不红** —— 没键盘时 limit 是 832，
   * 700 本来就在线上面，走不走那条守卫结果都一样。判据得挑一个
   * 「有守卫不滚、没守卫会滚」的位置才算数：900 在 844 的视口外面。
   */
  it('没键盘（inset=0）时整条不跑，哪怕框滚出视野了也不管', async () => {
    const s = scene(900);
    const m = mount(<Host inset={0} />);
    await act(async () => { await new Promise(r => setTimeout(r, 260)); });
    expect(s.scroller.scrollTop).toBe(0);
    m.unmount(); s.cleanup();
  });
});

describe('视口 meta 钉住覆盖模式', () => {
  const html = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');
  const meta = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] || '';

  it('写着 interactive-widget=resizes-visual', () => {
    expect(meta).toMatch(/interactive-widget=resizes-visual/);
  });

  it('⛔ 不许是 resizes-content（Chrome 108 之前的老行为，画布会跟着键盘重排）', () => {
    expect(meta).not.toMatch(/interactive-widget=resizes-content/);
  });

  it('⛔ 也不许是 overlays-content（连视觉视口都不缩 = visualViewport 量不出键盘）', () => {
    expect(meta).not.toMatch(/interactive-widget=overlays-content/);
  });
});

describe('抽屉真的抬到了键盘上面', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../components/layout/MobileShell.jsx'), 'utf8');

  it('底沿让开键盘那一截', () => {
    expect(src).toMatch(/bottom: kb,/);
  });

  it('⭐ 没键盘时仍然走原来那条 dvh —— 只在 inset > 0 时换算法', () => {
    expect(src).toMatch(/kb > 0\s*\n?\s*\?[^\n]*visibleH[\s\S]{0,80}dvh/);
  });
});
