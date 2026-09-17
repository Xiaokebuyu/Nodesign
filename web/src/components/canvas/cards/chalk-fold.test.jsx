// @vitest-environment happy-dom
/**
 * ChalkFold（09-09 建，09-17 板书树刀三改）：板书过长把中段折起来，头尾都在；
 * **展开走浮层**（portal 到 body，不撑高卡、不占板面、收起即消失），短的原样。
 * happy-dom 不排版，offsetHeight 靠 mock：把 [data-fold-probe] 的高度钉成想要的值。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ChalkFold, { overlayRect } from './ChalkFold.jsx';

let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** 正文渲染：一个带 probe 标记的块，高度由 offsetHeight mock 决定 */
function mountWith(contentH, { maxH = 376 } = {}) {
  // 这一层 mock 要在 useLayoutEffect 之前就位：ChalkFold 量的是 inner（render() 外面那层）的 offsetHeight，
  // 而 inner 是它自己造的 div —— 所以按原型 mock：凡是包着 probe 的元素报 contentH
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return this.querySelector?.('[data-fold-probe]') || this.hasAttribute?.('data-fold-probe') ? contentH : 0; },
  });
  act(() => root.render(
    <ChalkFold maxH={maxH} lineH={25.6} contentKey="k"
      render={() => <p data-fold-probe>头一句。中间很多行。末尾一句。</p>} />,
  ));
  return () => { if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc); else delete HTMLElement.prototype.offsetHeight; };
}

describe('ChalkFold', () => {
  it('放得下的板书原样画，没有中缝', () => {
    const restore = mountWith(200);
    try {
      expect(host.querySelector('[data-chalk-fold]').dataset.chalkFold).toBe('fits');
      expect(host.querySelectorAll('[data-fold-probe]')).toHaveLength(1);
      expect(host.textContent).not.toContain('展开');
    } finally { restore(); }
  });

  it('⭐ 超高的板书：头尾各一份、中缝报折了约多少行、外层收在 maxH 内', () => {
    const restore = mountWith(1200, { maxH: 376 });
    try {
      const box = host.querySelector('[data-chalk-fold]');
      expect(box.dataset.chalkFold).toBe('folded');
      expect(host.querySelectorAll('[data-fold-probe]'), '头段 + 尾段各画一份').toHaveLength(2);
      const btn = host.querySelector('button');
      expect(btn.textContent).toMatch(/中间折起约 \d+ 行/);
      // 头段裁在 headH、尾段裁在 tailH，两段加中缝 = maxH
      const [head, seam, tail] = box.children;
      const px = (el) => parseFloat(el.style.height);
      expect(px(head) + px(seam) + px(tail)).toBe(376);
      expect(head.style.overflow).toBe('hidden');
      expect(tail.style.overflow).toBe('hidden');
      // 尾段是同一份内容往上平移露出末尾
      expect(tail.firstChild.style.transform).toMatch(/translateY\(-\d+px\)/);
    } finally { restore(); }
  });

  it('⭐ 入口也是出口：点中缝 → 浮层里是全文加「收起」；再点收回；卡上那份始终折着', () => {
    const restore = mountWith(1200);
    try {
      act(() => host.querySelector('button').click());
      const box = host.querySelector('[data-chalk-fold]');
      expect(box.dataset.chalkFold).toBe('open');
      // ⭐ 卡上那份没有变：还是头段 + 中缝 + 尾段，高度仍收在 maxH 内（浮层不占板面）
      const [head, seam, tail] = box.children;
      const px = (el) => parseFloat(el.style.height);
      expect(px(head) + px(seam) + px(tail)).toBe(376);
      // 浮层 portal 到 body，不在卡里
      const overlay = document.querySelector('[data-chalk-overlay]');
      expect(overlay).toBeTruthy();
      expect(box.contains(overlay)).toBe(false);
      expect(overlay.textContent).toContain('收起');
      act(() => overlay.querySelector('button').click());
      expect(document.querySelector('[data-chalk-overlay]')).toBeNull();
      expect(host.querySelector('[data-chalk-fold]').dataset.chalkFold).toBe('folded');
    } finally { restore(); }
  });

  it('按 Esc 也收；点浮层外的空处也收', () => {
    const restore = mountWith(1200);
    try {
      act(() => host.querySelector('button').click());
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
      expect(document.querySelector('[data-chalk-overlay]')).toBeNull();
      act(() => host.querySelector('button').click());
      const overlay = document.querySelector('[data-chalk-overlay]');
      act(() => overlay.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(document.querySelector('[data-chalk-overlay]')).toBeNull();
    } finally { restore(); }
  });
});

describe('overlayRect：贴着卡展开，放不下翻到上方', () => {
  const card = (top, height = 380, left = 200, width = 432) => ({
    top, bottom: top + height, left, right: left + width, width, height,
  });

  it('下方够高就贴在卡下面', () => {
    const r = overlayRect(card(100), 1600, 1000);
    expect(r.flip).toBe(false);
    expect(r.top).toBeGreaterThanOrEqual(480 + 8 - 1);
    expect(r.maxHeight).toBeGreaterThan(240);
  });

  it('⭐ 卡贴着视口底、下面放不下 → 翻到上方，不越出视口', () => {
    const r = overlayRect(card(700), 1600, 1000);
    expect(r.flip).toBe(true);
    expect(r.top).toBeGreaterThanOrEqual(16);
    expect(r.top + r.maxHeight).toBeLessThanOrEqual(700);
  });

  it('横向夹在视口里：窄屏上不越左右边', () => {
    const wide = overlayRect(card(100, 380, -300, 900), 800, 1000);
    expect(wide.left).toBeGreaterThanOrEqual(16);
    expect(wide.left + wide.width).toBeLessThanOrEqual(800 - 16);
  });
});
