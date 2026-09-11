// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Type } from 'lucide-react';
import FloatingToolbar from './FloatingToolbar.jsx';

/**
 * 画布工具栏手动收放（2026-09-12 站主定，替掉「贴近底边自动浮现 + 图钉」）。
 *
 * 要钉住的四件事：默认展开；收起后留一枚舌头（入口必须同时是出口）；状态记得住；
 * Ctrl+\ 两头切但打字时不切。
 */
let host; let root;
const KEY = 'nd:tb-open:tools';
const GROUPS = [{ id: 'g', items: [{ id: 'text', icon: Type, title: '写一段字', onClick() {} }] }];

beforeEach(() => {
  localStorage.removeItem(KEY);
  host = document.createElement('div');
  host.style.position = 'relative';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.removeItem(KEY); });

const mount = () => {
  act(() => root.render(
    <FloatingToolbar id="tools" collapsible dock="bottom-center" stack="row" boundsRef={{ current: host }} groups={GROUPS} />,
  ));
};
const bar = () => host.querySelector('[data-floating-toolbar="tools"]');
const tab = () => host.querySelector('[data-edge-tab]');
const collapseBtn = () => host.querySelector('[data-tool-btn="collapse"]');
const press = (target = window) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backslash', key: '\\', ctrlKey: true, bubbles: true }));
});

describe('工具栏手动收放', () => {
  it('默认展开：工具在、末尾有「收起」、没有舌头', () => {
    mount();
    expect(bar().style.display).not.toBe('none');
    expect(collapseBtn(), '末尾缺「收起」').toBeTruthy();
    expect(tab()).toBeFalsy();
  });

  it('⭐ 点「收起」：整条藏起来，底边留一枚舌头（收得起就得叫得回）；点舌头又回来', () => {
    mount();
    act(() => collapseBtn().click());
    expect(bar().style.display).toBe('none');
    expect(tab(), '收起之后没有叫回来的入口').toBeTruthy();
    act(() => tab().click());
    expect(bar().style.display).not.toBe('none');
    expect(tab()).toBeFalsy();
  });

  it('状态记得住：收着的时候刷新，进来还是收着', () => {
    mount();
    act(() => collapseBtn().click());
    expect(localStorage.getItem(KEY)).toBe('0');
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(bar().style.display).toBe('none');
    expect(tab()).toBeTruthy();
  });

  it('Ctrl+\\ 两头切；焦点在输入框里时不切（那是在打字）', () => {
    mount();
    press();
    expect(bar().style.display).toBe('none');
    press();
    expect(bar().style.display).not.toBe('none');
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    press(ta);
    expect(bar().style.display, '在输入框里按也把工具栏收了').not.toBe('none');
    ta.remove();
  });

  it('不开 collapsible 的工具栏（别处复用）照旧常驻，没有「收起」也不听快捷键', () => {
    act(() => root.render(
      <FloatingToolbar id="tools" dock="bottom-center" boundsRef={{ current: host }} groups={GROUPS} />,
    ));
    expect(collapseBtn()).toBeFalsy();
    press();
    expect(bar().style.display).not.toBe('none');
  });
});
