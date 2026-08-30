// @vitest-environment happy-dom
/**
 * dock 卡不许被工具栏压住（2026-08-30 用户报：工具栏遮住 AskUserQuestion 的画布弹窗）。
 *
 * 真机量到的病灶：两个都钉在画布容器底边正中 ——
 *   工具栏 y 908–946（高 38，离底 20），dock 卡的底边 936
 *   → **卡片底部 28px 压在工具栏底下**，而问题卡的按钮正好在那一条
 *   → 工具栏 z-index 510、dock 80，永远是工具栏赢
 *
 * 这里钉的是让位后的算术，外加两条不许退化的：
 *   ⚠️ 高度必须**现量** —— 工具栏在窄容器里会折行，写死偏移到那一档又压上了
 *   ⚠️ 必须用 offsetTop 不用 getBoundingClientRect —— 工具栏自动收起时
 *      translateY(14px)，拿 rect 量的话卡片会跟着鼠标上下跳
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { StageDock } from './StageLayer.jsx';

const card = { blockId: 'b1', kind: 'chip', tool: 'Read', input: {} };

let host; let root; let toolbar; let frame;

/** happy-dom 不做排版，offsetTop / clientHeight 一律是 0 —— 手动喂真机量到的数 */
function fakeToolbar({ offsetTop, boxHeight = 950, rows = 1 }) {
  frame = document.createElement('div');
  Object.defineProperty(frame, 'clientHeight', { value: boxHeight, configurable: true });
  document.body.appendChild(frame);
  toolbar = document.createElement('div');
  toolbar.setAttribute('data-floating-toolbar', 'tools');
  Object.defineProperty(toolbar, 'offsetTop', { value: offsetTop, configurable: true });
  Object.defineProperty(toolbar, 'offsetParent', { value: frame, configurable: true });
  Object.defineProperty(toolbar, 'offsetHeight', { value: 38 * rows, configurable: true });
  frame.appendChild(toolbar);
}

function render(hostHeight = 950) {
  host = document.createElement('div');
  Object.defineProperty(host, 'clientHeight', { value: hostHeight, configurable: true });
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<StageDock dockPanels={[]} dockChips={[card]} onDismiss={() => {}} />); });
  return document.querySelector('[data-stage="dock"]');
}

beforeEach(() => {
  // happy-dom 没有 ResizeObserver
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  }
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove(); frame?.remove();
  host = root = toolbar = frame = undefined;
});

describe('dock 让开工具栏', () => {
  it('没有工具栏时贴底 14（保持原样）', () => {
    const el = render();
    expect(el).toBeTruthy();
    expect(el.style.bottom).toBe('14px');
  });

  it('⭐ 有工具栏时抬到它上面，留一条缝', () => {
    // 真机数：容器高 950，工具栏 offsetTop 908（高 38 + 离底 20）
    fakeToolbar({ offsetTop: 908 });
    const el = render();
    // 950 - 908 + 12 = 54 → 卡底边落在 y=896，工具栏顶 908，空 12
    expect(el.style.bottom).toBe('54px');
  });

  it('⚠️ 工具栏折成两排时跟着往上让（所以不能写死偏移）', () => {
    fakeToolbar({ offsetTop: 870, rows: 2 });
    expect(render().style.bottom).toBe('92px');
  });

  it('⛔ 工具栏离谱地高也不许把卡顶出容器（封顶四成）', () => {
    fakeToolbar({ offsetTop: 100 });
    // 想要 950-100+12=862，封顶到 950*0.4=380
    expect(render().style.bottom).toBe('380px');
  });

  it('⚠️ 量的是 offsetTop，不是 getBoundingClientRect', () => {
    // 工具栏自动收起时会 translateY(14px)：rect 会跟着变，offsetTop 不会。
    // 拿 rect 量的话卡片会随着鼠标进出底缘上下跳 14px。
    fakeToolbar({ offsetTop: 908 });
    Object.defineProperty(toolbar, 'getBoundingClientRect', {
      value: () => { throw new Error('不许用 rect 量工具栏位置'); },
      configurable: true,
    });
    expect(render().style.bottom).toBe('54px');
  });
});
