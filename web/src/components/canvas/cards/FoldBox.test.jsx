// @vitest-environment happy-dom
/**
 * 卡的高度天花板（2026-08-29 占位契约刀 B）。
 *
 * 判据先验：happy-dom 不做真实布局，scrollHeight 恒为 0 —— 直接渲染的话"没长出
 * 角标"永远成立，测了个寂寞（量具比 bug 还容易错）。所以这里把 scrollHeight 定义
 * 成可控值，用它扮演"内容有多高"，再断言折叠/角标/展开三件事。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import FoldBox from './FoldBox.jsx';
import { CARD_MAX_H } from '../../../lib/board-geometry.js';

/** 让这一棵树里所有 div 的 scrollHeight 都报同一个数（扮演内容高度） */
function stubScrollHeight(px) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true, get() { return px; },
  });
  return () => {
    if (desc) Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', desc);
  };
}

let host; let root; let restore = null;
function render(props = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<FoldBox {...props}>正文</FoldBox>); });
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  restore?.(); restore = null;
});

const foldBtn = (el) => [...el.querySelectorAll('button')].find(b => /展开|收起/.test(b.textContent));

describe('FoldBox', () => {
  it('⭐ 内容超过天花板 → 高度被限住 + 长出「展开」角标', () => {
    restore = stubScrollHeight(CARD_MAX_H * 3);
    const el = render();
    const inner = el.querySelector('[data-fold-body]');
    expect(inner.style.maxHeight).toBe(`${CARD_MAX_H}px`);
    expect(inner.style.overflow).toBe('hidden');
    expect(foldBtn(el)?.textContent).toMatch(/展开/);
  });

  it('⭐ 反向：内容没超 → 不限高、不长角标（防止角标永远都在）', () => {
    restore = stubScrollHeight(40);
    const el = render();
    const inner = el.querySelector('[data-fold-body]');
    expect(inner.style.maxHeight).toBe('');
    expect(foldBtn(el)).toBeUndefined();
  });

  it('⭐ open=true → 限高解除，角标变「收起」（展开是临时的，父层据此停掉高度回写）', () => {
    restore = stubScrollHeight(CARD_MAX_H * 3);
    const el = render({ open: true });
    const inner = el.querySelector('[data-fold-body]');
    expect(inner.style.maxHeight).toBe('');
    expect(foldBtn(el)?.textContent).toMatch(/收起/);
  });

  it('点角标回调 onToggle（状态由父层持有 —— 它还要拿去关掉测量回写）', () => {
    restore = stubScrollHeight(CARD_MAX_H * 3);
    const onToggle = vi.fn();
    const el = render({ onToggle });
    act(() => { foldBtn(el).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
