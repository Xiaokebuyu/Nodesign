// @vitest-environment happy-dom
/**
 * 边缘舌头（2026-08-21）。钉住四件事，每一件都是真栽过的：
 *   0. 舌头**只在手指设备上**渲染 —— 桌面那条「边缘不该有任何常驻遮挡」还算数。
 *   1. 点舌头打开的卡**不许自己收**——触屏上指针永远不会"进卡"，
 *      老代码那条 1.2s 兜底会在点开 1.2 秒后把卡收走，手机上等于按钮失灵。
 *   2. 贴纸的命中区必须比看得见的那一片大（手指没有像素级准头）。
 *   3. 撕口的 clip-path 只能画在里面那片纸上——画在按钮本体上会把命中区一起裁掉。
 *
 * 2026-08-29 外壳第二刀之后，这几条**只管平板档**（粗指针 + 短边 ≥600）。
 * 手机档整个换了一层皮：没有卡、没有舌头，是底部抽屉 + 一颗说话钮 —— 最后
 * 一条判据钉的就是这个分界，别让哪天有人把手机又退回边缘卡。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ChatDock from './ChatDock.jsx';
import { TAB_HIT, TAB_LEN } from '../ui/EdgeTab.jsx';

/**
 * 假的 matchMedia：happy-dom 里指针一律是 fine，不换掉的话舌头根本不渲染。
 * 换的时候把**两条 query 都答上** —— 只答 coarse 会让 useViewportWidth 那类调用拿到 undefined。
 */
function setPointer(kind) {
  window.matchMedia = (q) => ({
    matches: q.includes('coarse') ? kind === 'coarse' : false,
    media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
}

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ChatDock {...props}>{() => <div data-testid="panel" />}</ChatDock>);
  });
  return {
    host,
    tab: () => host.querySelector('[data-edge-tab]'),
    // ⚠️ 别按 z-index 认它：08-29 手机抽屉也用了 120，靠魔法数字认元素当场认错。
    // 认一个专门的标记，这样"卡"和"抽屉"永远分得开。
    card: () => host.querySelector('[data-chat-card]'),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

beforeEach(() => { setPointer('coarse'); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('ChatDock 的边缘贴纸', () => {
  it('桌面（细指针）不长舌头 —— 屏缘零常驻遮挡那条还算数', () => {
    setPointer('fine');
    const m = mount({});
    expect(m.tab()).toBeNull();
    expect(m.card()).toBeTruthy();     // 卡本身照旧在，贴边 hover 唤出
    m.unmount();
  });

  it('一进来卡是关着的，但舌头在（关着也得有入口）', () => {
    const m = mount({});
    expect(m.tab()).toBeTruthy();
    expect(m.card().style.visibility).toBe('hidden');
    expect(m.tab().getAttribute('aria-expanded')).toBe('false');
    m.unmount();
  });

  it('点舌头打开，2 秒之后还开着 —— 触屏上没有"鼠标进卡"这回事', () => {
    vi.useFakeTimers();
    const m = mount({});
    act(() => { m.tab().click(); });
    expect(m.card().style.visibility).toBe('visible');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(m.card().style.visibility, '被 1.2s 兜底计时器收走了：手机上点开就没').toBe('visible');
    m.unmount();
  });

  it('再点一下收起，舌头的 aria-expanded 跟着翻', () => {
    const m = mount({});
    act(() => { m.tab().click(); });
    expect(m.tab().getAttribute('aria-expanded')).toBe('true');
    act(() => { m.tab().click(); });
    expect(m.card().style.visibility).toBe('hidden');
    expect(m.tab().getAttribute('aria-expanded')).toBe('false');
    m.unmount();
  });

  it('命中区比看得见的那一片大，且切角不在按钮本体上（裁了会连命中区一起裁）', () => {
    const m = mount({});
    const btn = m.tab();
    const paper = btn.firstElementChild;
    expect(Number.parseFloat(btn.style.width)).toBe(TAB_HIT);
    expect(Number.parseFloat(btn.style.height)).toBe(TAB_LEN);
    expect(Number.parseFloat(paper.style.width)).toBeLessThan(TAB_HIT);
    expect(Number.parseFloat(paper.style.height)).toBeLessThan(TAB_LEN);
    expect(btn.style.clipPath, 'clip-path 画在按钮上 = 中心点可能落进缺口里').toBeFalsy();
    expect(paper.style.clipPath).toContain('polygon');
    m.unmount();
  });

  it('平板上卡铺不满但留出舌头那一条', () => {
    const real = window.innerWidth;
    // 810 = iPad 竖屏宽；短边仍是 happy-dom 的默认高（768）→ 平板档，走边缘卡
    Object.defineProperty(window, 'innerWidth', { value: 810, configurable: true });
    const m = mount({});
    act(() => { m.tab().click(); });
    const w = Number.parseFloat(m.card().style.width);
    expect(w).toBeLessThan(810 - TAB_HIT / 2);   // 舌头压不出屏
    expect(w).toBeGreaterThan(300);              // 也不至于缩成一条
    m.unmount();
    Object.defineProperty(window, 'innerWidth', { value: real, configurable: true });
  });

  /**
   * 手机档换皮（2026-08-29）。这条钉的是**分界本身**：
   * 边缘卡那一套（贴屏缘召唤 / 舌头 / 宽度把手 / 图钉）在手机上一条都不成立，
   * 所以整层换成底部抽屉 + 说话钮。哪天有人顺手把手机退回边缘卡，这条会拦住。
   */
  it('手机档：没有卡也没有舌头，换成抽屉 + 说话钮', () => {
    const realW = window.innerWidth; const realH = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 664, configurable: true });
    const m = mount({});
    expect(m.tab(), '手机上不该再有边缘舌头').toBe(null);
    expect(m.card(), '手机上不该再有那张边缘卡').toBe(null);
    const fab = m.host.querySelector('[data-talk-fab]');
    expect(fab, '手机上得有一颗「跟它说话」的钮').toBeTruthy();
    // 抽屉先关着；点钮拉开，钮自己让位（一颗盖在抽屉上的圆钮既挡字又没意义）
    const sheet = () => m.host.querySelector('[data-mobile-sheet]');
    expect(sheet().style.visibility).toBe('hidden');
    act(() => { fab.click(); });
    expect(sheet().style.visibility).toBe('visible');
    expect(m.host.querySelector('[data-talk-fab]')).toBe(null);
    m.unmount();
    Object.defineProperty(window, 'innerWidth', { value: realW, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: realH, configurable: true });
  });
});
