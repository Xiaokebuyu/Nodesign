// @vitest-environment happy-dom
// 前端量出卡长高 → 回写尺寸 + 撞上的话题整组让开（09-18）。只长不缩；文件夹卡推不动；没座位的不凭空造。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTopicSettle } from './useTopicSettle.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root; let fn;
afterEach(() => { act(() => root?.unmount()); });

const card = (id, x, y, w, h, tag) => ({ id, type: 'note', chalk: true, tag, pos: { x, y, w, h, tag } });
function setup({ positioned, layout, folders = [], bindings = {} }) {
  const state = { layout: { ...layout } };
  const deps = {
    layoutRef: { current: state.layout },
    positionedRef: { current: positioned },
    folderViewRef: { current: folders },
    bindings,
    patchLayout: vi.fn((id, p) => { state.layout[id] = { ...state.layout[id], ...p }; }),
    setLayout: vi.fn((f) => { state.layout = f(state.layout); }),
    dirtyRef: { current: { objects: new Set(), zones: new Set() } },
    scheduleSave: vi.fn(),
  };
  function Probe() { fn = useTopicSettle(deps); return null; }
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  return { deps, state };
}

describe('useTopicSettle', () => {
  it('⭐ 量出长高：先回写尺寸，再把撞上的话题整组推开并记脏', () => {
    const positioned = [card('a', 0, 0, 400, 100, 'A'), card('b1', 0, 140, 200, 80, 'B'), card('b2', 220, 140, 200, 80, 'B')];
    const layout = { a: { x: 0, y: 0, w: 400, h: 100 }, b1: { x: 0, y: 140 }, b2: { x: 220, y: 140 } };
    const { deps, state } = setup({ positioned, layout });
    act(() => fn('a', { h: 600 }));
    expect(deps.patchLayout).toHaveBeenCalledWith('a', { h: 600 });
    const d1 = [state.layout.b1.x, state.layout.b1.y]; const d2 = [state.layout.b2.x - 220, state.layout.b2.y];
    expect(d1).toEqual(d2);                          // 整组一起
    expect(d1).not.toEqual([0, 140]);
    expect(deps.dirtyRef.current.objects.has('b1')).toBe(true);
    expect(deps.scheduleSave).toHaveBeenCalled();
  });

  it('变矮或没变大：只回写，不推人', () => {
    const positioned = [card('a', 0, 0, 400, 300, 'A'), card('b', 0, 340, 200, 80, 'B')];
    const { deps } = setup({ positioned, layout: { a: { x: 0, y: 0, w: 400, h: 300 }, b: { x: 0, y: 340 } } });
    act(() => fn('a', { h: 200 }));
    expect(deps.setLayout).not.toHaveBeenCalled();
  });
});
