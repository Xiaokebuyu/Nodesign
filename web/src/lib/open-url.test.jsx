// @vitest-environment happy-dom
// 正文里的链接不许在本窗口开（2026-09-10 站主报的白屏：点了 dev server 地址，
// 桌面版整个应用被导航走，只能重启）。规矩和原委在 lib/open-url.js。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import MarkdownMath from '../components/ui/MarkdownMath.jsx';

function render(md) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<MarkdownMath>{md}</MarkdownMath>); });
  return { host, cleanup: () => { act(() => { root.unmount(); }); host.remove(); } };
}

function click(a) {
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  return ev;
}

describe('正文里的链接', () => {
  let openSpy;
  beforeEach(() => {
    delete window.nodesignDesktop;
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => { openSpy.mockRestore(); });

  it('http 链接：点击被吃掉（不发生本窗口导航），改为在窗口之外打开', () => {
    const { host, cleanup } = render('服务起好了：http://localhost:5173');
    const a = host.querySelector('a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noreferrer');
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(true);
    expect(openSpy).toHaveBeenCalledWith('http://localhost:5173/', '_blank', 'noopener');
    cleanup();
  });

  it('桌面版走壳的桥，交给系统浏览器', () => {
    const openExternal = vi.fn(() => Promise.resolve(true));
    window.nodesignDesktop = { openExternal };
    const { host, cleanup } = render('[看看](http://127.0.0.1:5173/index.html)');
    click(host.querySelector('a'));
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:5173/index.html');
    expect(openSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it('相对地址也不在本窗口开（补全成绝对地址）', () => {
    const { host, cleanup } = render('[产物](./trace/public/index.html)');
    const ev = click(host.querySelector('a'));
    expect(ev.defaultPrevented).toBe(true);
    expect(openSpy.mock.calls[0][0]).toMatch(/\/trace\/public\/index\.html$/);
    cleanup();
  });

  it('页内锚点留默认：不拦、不开新窗口', () => {
    const { host, cleanup } = render('[回目录](#toc)');
    const a = host.querySelector('a');
    expect(a.getAttribute('target')).toBe(null);
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    cleanup();
  });
});
