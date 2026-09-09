// @vitest-environment happy-dom
/**
 * 产物窗给钉住的聊天卡让位（09-09）：桌面档、卡钉住 → 纸在卡那一侧收进去；卡悬浮 / 收起 → 不动。
 * 六扇窗共用 ArtifactWindow 这一个壳，钉这一处就够。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ArtifactWindow from './ArtifactWindow.jsx';
import { useGlobalStore } from '../../stores/globalStore.js';

let host; let root;
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); useGlobalStore.getState().setChatDockPinned(null); });

const paper = () => host.querySelector('[data-artifact-paper]');
const render = () => act(() => root.render(<ArtifactWindow title="站点" onClose={() => {}}><div>内容</div></ArtifactWindow>));

describe('ArtifactWindow 让位', () => {
  it('卡没钉住：纸照旧 inset 8/10', () => {
    render();
    expect(paper().style.right).toBe('10px');
    expect(paper().style.left).toBe('10px');
  });
  it('⭐ 卡钉在右边 388 宽 → 纸右边收到 398，左边不动；取消钉住 → 回来', () => {
    act(() => useGlobalStore.getState().setChatDockPinned({ side: 'right', width: 388 }));
    render();
    expect(paper().style.right).toBe('398px');
    expect(paper().style.left).toBe('10px');
    act(() => useGlobalStore.getState().setChatDockPinned(null));
    expect(paper().style.right).toBe('10px');
  });
  it('卡钉在左边 → 收左边', () => {
    act(() => useGlobalStore.getState().setChatDockPinned({ side: 'left', width: 300 }));
    render();
    expect(paper().style.left).toBe('310px');
    expect(paper().style.right).toBe('10px');
  });
});
