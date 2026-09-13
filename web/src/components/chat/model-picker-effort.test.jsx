// @vitest-environment happy-dom
/**
 * 思考等级嵌进模型选择器（09-13 站主）：可调的模型行尾有档位 + 展开箭头，展开是二级菜单；
 * 同一个模型只换档 = 只发 effort（不换模型、不作废缓存）；换模型时带上所选档位；没会话记本地偏好。
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const OPTIONS = [
  { id: 'claude-sonnet-5[1m]', label: 'Sonnet 5', desc: '响应快', brand: 'claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'glm-5.3-flash-tokenrhythm', label: 'GLM-5.3-Flash · 基元律动', desc: '第二条渠道 · 这是一段很长很长的描述用来确认菜单不会被撑宽', brand: 'glm' },
];
vi.mock('../../lib/api.js', async (orig) => {
  const mod = await orig();
  return {
    ...mod,
    Sessions: { ...mod.Sessions, model: vi.fn(async () => ({ model: 'claude-sonnet-5[1m]', override: null, default: 'claude-sonnet-5[1m]', options: OPTIONS, effort: 'medium' })), setModel: vi.fn(async (_p, _s, model, effort) => ({ model: model || 'claude-sonnet-5[1m]', effort: effort || 'medium', options: OPTIONS })) },
    Me: { ...mod.Me, models: vi.fn(async () => ({ options: OPTIONS, default: 'claude-sonnet-5[1m]' })) },
  };
});
const { Sessions } = await import('../../lib/api.js');
const { useGlobalStore } = await import('../../stores/globalStore.js');
const { default: ModelPicker } = await import('./ModelPicker.jsx');

let host; let root;
async function render(props) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelPicker {...props} />); });
  await act(async () => { await Promise.resolve(); });
  return host;
}
const q = (sel) => document.body.querySelector(sel);
const qa = (sel) => [...document.body.querySelectorAll(sel)];
beforeEach(() => { useGlobalStore.setState({ modelPref: 'claude-sonnet-5[1m]', effortPrefs: {} }); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

describe('模型选择器里的思考等级', () => {
  it('按钮上印当前档位；只有可调的模型行有展开箭头', async () => {
    const el = await render({ projectId: 'proj_a', sessionId: 'sess-1' });
    expect(el.querySelector('[data-testid="effort-badge"]').textContent).toContain('中');
    await act(async () => { el.querySelector('button').click(); });
    expect(qa('[data-testid="effort-toggle"]')).toHaveLength(1);
  });

  it('⭐ 同一个模型只换档：展开二级菜单点「高」→ 只发 effort，不带 model', async () => {
    const el = await render({ projectId: 'proj_a', sessionId: 'sess-1' });
    await act(async () => { el.querySelector('button').click(); });
    await act(async () => { q('[data-testid="effort-toggle"]').click(); });
    const high = qa('[data-testid="effort-menu"] [role="menuitemradio"]').find((b) => b.textContent.includes('高') && !b.textContent.includes('更高'));
    expect(high).toBeTruthy();
    await act(async () => { high.click(); });
    expect(Sessions.setModel).toHaveBeenCalledWith('proj_a', 'sess-1', undefined, 'high');
    expect(useGlobalStore.getState().effortPrefs['claude-sonnet-5[1m]']).toBe('high');
  });

  it('当前档位打勾、默认档标「默认」', async () => {
    const el = await render({ projectId: 'proj_a', sessionId: 'sess-1' });
    await act(async () => { el.querySelector('button').click(); });
    await act(async () => { q('[data-testid="effort-toggle"]').click(); });
    const items = qa('[data-testid="effort-menu"] [role="menuitemradio"]');
    expect(items.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false', 'false']);
    expect(items[1].textContent).toContain('默认');
  });

  it('没会话：选档只记本地偏好（按模型），不发请求', async () => {
    const el = await render({});
    await act(async () => { el.querySelector('button').click(); });
    await act(async () => { q('[data-testid="effort-toggle"]').click(); });
    const max = qa('[data-testid="effort-menu"] [role="menuitemradio"]').at(-1);
    await act(async () => { max.click(); });
    expect(Sessions.setModel).not.toHaveBeenCalled();
    expect(useGlobalStore.getState().effortPrefs['claude-sonnet-5[1m]']).toBe('max');
    expect(useGlobalStore.getState().modelPref).toBe('claude-sonnet-5[1m]');
  });

  it('宽度封顶：菜单是固定上限宽度而不是被最长描述撑开；按钮有 maxWidth', async () => {
    const el = await render({ projectId: 'proj_a', sessionId: 'sess-1' });
    expect(el.querySelector('button').style.maxWidth).toBe('240px');
    await act(async () => { el.querySelector('button').click(); });
    const panel = q('[data-nd-popover] > div');
    expect(panel.style.width).toBe(`${Math.min(320, window.innerWidth - 32)}px`);
    expect(panel.style.minWidth).toBe('');
  });
});
