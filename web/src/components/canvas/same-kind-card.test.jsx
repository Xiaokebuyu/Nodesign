// @vitest-environment happy-dom
// 同类收卡（09-18）：只装同一类产物的文件夹卡，卡面是选中的那一件、标题栏下拉切换；工具栏下拉（站点换页 / word 版本）同一个控件。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import FolderCard from './cards/FolderCard.jsx';
import { toolbarSelect } from '../ui/toolbar-select.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };

let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const members = [{ id: 'site:方向/v3', type: 'site', title: 'v3' }, { id: 'site:方向/v1', type: 'site', title: 'v1' }];
const z = (same) => ({ id: '方向', title: '方向', x: 0, y: 0, w: 288, h: 240, count: 2, peek: [], same });

describe('FolderCard 同类收卡', () => {
  it('⭐ 卡面是选中那一件，标题栏下拉切换；没选过的显示最近那件', () => {
    const onPick = vi.fn();
    act(() => root.render(<FolderCard z={z({ kind: 'site', members })} projectId="p" scale={0.3} onPick={onPick} />));
    const sel = host.querySelector('[data-same-kind-pick]');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['v3', 'v1']);
    expect(sel.value).toBe('site:方向/v3');
    expect(host.querySelector('[data-same-kind="site"]').textContent).toContain('v3');
    expect(host.textContent).toContain('站点 · 2 份');
    act(() => { sel.value = 'site:方向/v1'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onPick).toHaveBeenCalledWith('site:方向/v1');
  });

  it('选过的那件照它显示；普通文件夹没有下拉', () => {
    act(() => root.render(<FolderCard z={z({ kind: 'site', members })} projectId="p" scale={0.3} pick="site:方向/v1" />));
    expect(host.querySelector('[data-same-kind-pick]').value).toBe('site:方向/v1');
    act(() => root.render(<FolderCard z={z(null)} projectId="p" scale={0.3} />));
    expect(host.querySelector('[data-same-kind-pick]')).toBeNull();
  });
});

describe('toolbarSelect', () => {
  it('给出 node 组、value 带上（工具栏签名守卫只看 id + value）', () => {
    const onChange = vi.fn();
    const g = toolbarSelect({ id: 'pages', value: 'about.html', onChange, options: [{ value: 'index.html', label: 'index' }, { value: 'about.html', label: 'about' }] });
    expect(g).toMatchObject({ id: 'pages', value: 'about.html' });
    act(() => root.render(g.node));
    const sel = host.querySelector('[data-toolbar-select="pages"]');
    expect(sel.value).toBe('about.html');
    act(() => { sel.value = 'index.html'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('index.html');
  });
});
