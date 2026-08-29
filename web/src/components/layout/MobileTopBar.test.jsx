// @vitest-environment happy-dom
/**
 * 常驻窄条上那颗 ‹ 的层次（2026-08-29 移动端外壳第三刀）。
 *
 * 「先退最里面那一层」这句话拆成两半：**哪一层最里面**由调用方判断
 * （它才知道有没有窗开着），**画一颗按钮**由版面件负责。这个文件钉的是
 * 两半的接缝 —— 接错了不报错，只表现为「手机上按返回没反应」或者
 * 「按返回退错了层」。
 */
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MobileTopBar } from './MobileShell.jsx';

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<MobileTopBar {...props} />); });
  return {
    host,
    back: () => host.querySelector('button'),
    here: () => host.querySelector('span')?.textContent,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

const CRUMBS = [
  { label: '项目', onClick: vi.fn() },
  { label: '甲文件夹', onClick: vi.fn() },
  { label: '乙文件夹' },
];

describe('返回键的层次', () => {
  it('只有一级、也没给回首页 → 灰着（版面件自己不编路）', () => {
    const m = mount({ breadcrumb: [{ label: '项目' }] });
    expect(m.back().disabled).toBe(true);
    m.unmount();
  });

  /**
   * ⛔ 08-29 用户报「返回键不可点」。真相比"不可点"更糟：桌面靠左上角 Nodesign
   * 字标回首页，移动条上砍掉了 —— 手机上进了项目就**没有任何回首页的路**。
   * 退到尽头该是"离开这一页"，不是"灰掉"；一颗永远灰着的返回键读起来就是坏了。
   */
  it('⭐ 退到尽头 = 回首页，不是灰掉', () => {
    const home = vi.fn();
    const m = mount({ breadcrumb: [{ label: '项目' }], onHome: home });
    expect(m.back().disabled, '有回首页可退就不该灰').toBe(false);
    expect(m.back().getAttribute('aria-label')).toContain('项目列表');
    act(() => { m.back().click(); });
    expect(home).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('层次从里往外：窗 > 文件夹上一级 > 回首页，一次只退一层', () => {
    const close = vi.fn(); const up = vi.fn(); const home = vi.fn();
    const deep = { breadcrumb: [{ label: '项目' }, { label: '甲', onClick: up }, { label: '乙' }] };
    // 有窗：只关窗
    let m = mount({ ...deep, onBack: close, onHome: home });
    act(() => { m.back().click(); });
    expect([close.mock.calls.length, up.mock.calls.length, home.mock.calls.length]).toEqual([1, 0, 0]);
    m.unmount();
    // 没窗但在文件夹里：只退一层，不回首页
    m = mount({ ...deep, onHome: home });
    act(() => { m.back().click(); });
    expect([up.mock.calls.length, home.mock.calls.length]).toEqual([1, 0]);
    m.unmount();
  });

  it('在文件夹里 → 退到面包屑倒数第二级', () => {
    const up = vi.fn();
    const m = mount({ breadcrumb: [{ label: '项目' }, { label: '甲', onClick: up }, { label: '乙' }] });
    expect(m.back().disabled).toBe(false);
    act(() => { m.back().click(); });
    expect(up).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('⭐ 有窗开着（调用方给了 onBack）→ 盖过面包屑，先关窗', () => {
    const up = vi.fn(); const close = vi.fn();
    const m = mount({
      breadcrumb: [{ label: '项目' }, { label: '甲', onClick: up }, { label: '乙' }],
      onBack: close,
    });
    act(() => { m.back().click(); });
    expect(close, '窗开着时该关窗').toHaveBeenCalledTimes(1);
    expect(up, '不该顺手把文件夹层也退掉 —— 一次只退一层').not.toHaveBeenCalled();
    m.unmount();
  });

  it('在根上但有窗开着 → 照样可点（这时候返回键是唯一的退路）', () => {
    const close = vi.fn();
    const m = mount({ breadcrumb: [{ label: '项目' }], onBack: close });
    expect(m.back().disabled).toBe(false);
    act(() => { m.back().click(); });
    expect(close).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('条上印的是"你现在在哪"，也就是最后一级', () => {
    const m = mount({ breadcrumb: CRUMBS });
    expect(m.here()).toBe('乙文件夹');
    m.unmount();
  });

  it('面包屑空着（刚进页面还没上报）不炸', () => {
    const m = mount({ breadcrumb: [] });
    expect(m.back().disabled).toBe(true);
    expect(m.here()).toBe('');
    m.unmount();
  });
});
