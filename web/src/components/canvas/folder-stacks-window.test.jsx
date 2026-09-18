// @vitest-environment happy-dom
// 文件夹窗归堆（09-18）真渲：件数多时叠成几堆、点一堆摊开带「收起」、工具栏能换轴、件数少照旧平铺。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import FolderWindow from './FolderWindow.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} disconnect() {} };

let host; let root; let toolbar;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* */ }
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const day = 86_400_000;
const img = (i, ageDays) => ({ id: `assets/generated/g${i}.png`, type: 'image', title: `g${i}`, mtime: new Date(Date.now() - ageDays * day).toISOString() });
const render = (items, dir = 'assets/generated') => act(() => root.render(
  <FolderWindow
    dir={dir}
    list={() => ({ folders: [], items })}
    onClose={() => {}}
    onToolbarGroups={(g) => { toolbar = g; }}
    renderObject={(o, pos) => <div data-card={o.id} style={{ position: 'absolute', left: pos.x, top: pos.y }} />}
    renderFolder={() => null}
  />,
));
const cards = () => [...host.querySelectorAll('[data-card]')].map((e) => e.getAttribute('data-card'));
const piles = () => [...host.querySelectorAll('[data-folder-stack]')].map((e) => e.getAttribute('data-folder-stack'));

describe('FolderWindow 归堆', () => {
  it('⭐ 清一色的图超过 8 张：按时间叠，一堆只露最近那张；点开摊开整堆，收起合回去', () => {
    const items = [...Array.from({ length: 6 }, (_, i) => img(i, 0)), ...Array.from({ length: 4 }, (_, i) => img(10 + i, 40))];
    render(items);
    expect(piles()).toEqual(['time:今天', expect.stringMatching(/^time:\d{4} 年 \d+ 月$/)]);
    expect(cards()).toHaveLength(2);
    act(() => host.querySelector('[data-folder-stack="time:今天"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector('[data-folder-stack-header="time:今天"]')).toBeTruthy();
    expect(cards()).toHaveLength(7);   // 摊开的 6 张 + 另一堆露出的 1 张
    act(() => host.querySelector('[data-folder-stack-header="time:今天"] button').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(cards()).toHaveLength(2);
  });

  it('工具栏换成「不叠」就平铺；换轴记在本机', () => {
    const items = Array.from({ length: 10 }, (_, i) => img(i, i));
    render(items);
    const stack = toolbar.find((g) => g.id === 'stack');
    expect(stack.value).toBe('time');
    act(() => stack.onChange('none'));
    expect(piles()).toEqual([]);
    expect(cards()).toHaveLength(10);
    expect(localStorage.getItem('nd:folder-stack:assets/generated')).toBe('none');
  });

  it('件数不多照旧平铺，不出堆', () => {
    render(Array.from({ length: 3 }, (_, i) => img(i, i * 40)), '稿');
    expect(piles()).toEqual([]);
    expect(cards()).toHaveLength(3);
  });
});

vi.restoreAllMocks();
