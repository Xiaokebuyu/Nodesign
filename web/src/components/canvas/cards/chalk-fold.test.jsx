// @vitest-environment happy-dom
/**
 * ChalkFold（09-09）：板书过长把中段折起来 —— 头尾都在、中缝能展开、展开后能收回；短的原样。
 * happy-dom 不排版，offsetHeight 靠 mock：把 [data-fold-probe] 的高度钉成想要的值。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ChalkFold from './ChalkFold.jsx';

let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** 正文渲染：一个带 probe 标记的块，高度由 offsetHeight mock 决定 */
function mountWith(contentH, { maxH = 376, onOpenChange } = {}) {
  // 这一层 mock 要在 useLayoutEffect 之前就位：ChalkFold 量的是 inner（render() 外面那层）的 offsetHeight，
  // 而 inner 是它自己造的 div —— 所以按原型 mock：凡是包着 probe 的元素报 contentH
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return this.querySelector?.('[data-fold-probe]') || this.hasAttribute?.('data-fold-probe') ? contentH : 0; },
  });
  act(() => root.render(
    <ChalkFold maxH={maxH} lineH={25.6} contentKey="k" onOpenChange={onOpenChange}
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

  it('⭐ 入口也是出口：点中缝展开 → 全文 + 「收起」；再点收回去；两次都告诉父层', () => {
    const opens = [];
    const restore = mountWith(1200, { onOpenChange: (v) => opens.push(v) });
    try {
      act(() => host.querySelector('button').click());
      expect(host.querySelector('[data-chalk-fold]').dataset.chalkFold).toBe('open');
      expect(host.querySelectorAll('[data-fold-probe]'), '展开后只画一份、不裁').toHaveLength(1);
      expect(host.querySelector('[data-chalk-fold] > div').style.height).toBe('');
      const close = host.querySelector('button');
      expect(close.textContent).toContain('收起');
      act(() => close.click());
      expect(host.querySelector('[data-chalk-fold]').dataset.chalkFold).toBe('folded');
      expect(opens).toEqual([true, false]);
    } finally { restore(); }
  });
});
