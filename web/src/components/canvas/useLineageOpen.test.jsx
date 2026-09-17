// @vitest-environment happy-dom
// 谱系展开集（09-17 从 BoardCanvas 搬出）：点一下展开、再点收起，每次报一笔；只读视图不报。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../lib/api.js', () => ({ jsonRequest: vi.fn(() => Promise.resolve({ ok: true })) }));
const { jsonRequest } = await import('../../lib/api.js');
const { useLineageOpen } = await import('./useLineageOpen.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root; let api;
function Probe({ readOnly }) {
  api = useLineageOpen('proj_1', { readOnly });
  return null;
}
const mount = (readOnly = false) => act(() => { root.render(<Probe readOnly={readOnly} />); });

beforeEach(() => { host = document.createElement('div'); root = createRoot(host); jsonRequest.mockClear(); });
afterEach(() => { act(() => root.unmount()); });

describe('useLineageOpen', () => {
  it('点开 → 集合里有它并报 open:true；再点 → 移除并报 open:false', () => {
    mount();
    act(() => api[1]('site:v3', 2));
    expect(api[0].has('site:v3')).toBe(true);
    expect(jsonRequest).toHaveBeenLastCalledWith('POST', '/api/projects/proj_1/board/lineage-toggle', { tip: 'site:v3', count: 2, open: true });
    act(() => api[1]('site:v3', 2));
    expect(api[0].has('site:v3')).toBe(false);
    expect(jsonRequest).toHaveBeenLastCalledWith('POST', '/api/projects/proj_1/board/lineage-toggle', { tip: 'site:v3', count: 2, open: false });
    expect(jsonRequest).toHaveBeenCalledTimes(2);
  });
  it('只读视图（截图通道）照常展开，但不报', () => {
    mount(true);
    act(() => api[1]('site:v3', 1));
    expect(api[0].has('site:v3')).toBe(true);
    expect(jsonRequest).not.toHaveBeenCalled();
  });
});
