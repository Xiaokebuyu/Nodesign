// @vitest-environment happy-dom
/**
 * 站点模型总闸这一页（09-10）。
 *
 * 钉的是这页**唯一**的价值：一眼看出"此刻这行能不能用、为什么、关掉会牵连谁"。
 * 编译过不算数（见 feedback-refactor-needs-runtime-proof）—— 这里真渲一遍、真点一下。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const patchModel = vi.fn();
const models = vi.fn();
const modelSlots = vi.fn();
const saveModelSlots = vi.fn();
vi.mock('../../lib/api-admin.js', () => ({
  Admin: {
    models: (...a) => models(...a), patchModel: (...a) => patchModel(...a),
    modelSlots: (...a) => modelSlots(...a), saveModelSlots: (...a) => saveModelSlots(...a),
  },
}));

/** GET /api/admin/models/slots 的形状（表单要的枚举都从服务端来，前端不另起一份） */
const SLOTS = {
  raw: { upstreams: {}, models: [] }, errors: [], activeExternalModels: [], shadowedBuiltinModels: [],
  reservedUpstreamIds: ['merge'], reservedModelIds: ['claude-sonnet-5[1m]'], shadowableModelIds: ['deepseek-v4.1-flash'],
  builtinUpstreams: { merge: { label: 'Merge Gateway', keyPresent: true } },
  enums: { PROTOCOLS: ['anthropic', 'openai-chat'], AUTH_STYLES: ['x-api-key', 'bearer', 'none'], THINKING_MODES: ['strip'], REASONING_EFFORTS: ['high'], BRANDS: ['deepseek', 'custom'], MAX_RETRY_BUDGET_MS: 400000 },
  updatedAt: null, updatedBy: null, readOnly: false,
};

const { ModelSwitchboard } = await import('./ModelSwitchboard.jsx');
const { useGlobalStore } = await import('../../stores/globalStore.js');

const row = (over = {}) => ({
  id: 'deepseek-v4.1-flash-merge', brand: 'deepseek', window: 1_000_000, external: false, subscription: false,
  label: 'DeepSeek V4.1 Flash · Merge 网关', desc: '响应快', selectable: true, gate: null, only: null,
  upstream: 'merge', wireModel: 'deepseek/deepseek-v4.1-flash',
  prices: { input: 0.15, output: 0.6 }, standby: null,
  unavailable: { why: '上游高峰时段涨价', tz: 'UTC', windows: ['01:00-04:00', '06:00-10:00'] },
  unavailableSource: 'row', builtinUnavailable: { why: '上游高峰时段涨价', tz: 'UTC', windows: ['01:00-04:00', '06:00-10:00'] },
  enabled: true, switchedAt: null, switchedBy: null, switchNote: null,
  closedNow: null, usedAsFastBy: [], usedAsStandbyBy: [], ...over,
});

let host; let root;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  patchModel.mockReset(); models.mockReset(); modelSlots.mockReset(); saveModelSlots.mockReset();
  modelSlots.mockResolvedValue(SLOTS);
});
afterEach(() => { act(() => root.unmount()); host.remove(); useGlobalStore.setState({ toasts: [] }); });

const render = async (list) => {
  models.mockResolvedValue({ models: list });
  await act(async () => { root.render(<ModelSwitchboard />); });
};
const text = () => host.textContent;
const toggleBtn = () => [...host.querySelectorAll('button')].find(b => /停用|启用/.test(b.textContent));

describe('ModelSwitchboard', () => {
  it('正常的行：摆出上游 / 发出去的名字 / 价 / 关门时段，按钮写着「停用」', async () => {
    await render([row()]);
    expect(text()).toContain('DeepSeek V4.1 Flash · Merge 网关');
    expect(text()).toContain('merge/deepseek/deepseek-v4.1-flash');   // 展示名 ≠ 发出去的名字，两个都要看得见
    expect(text()).toContain('$0.15');
    expect(text()).toContain('01:00-04:00');
    expect(text()).toContain('1M 上下文');
    expect(toggleBtn().textContent).toContain('停用');
  });

  it('撞在钟点闸里：写「关门中 · 几点恢复」，但不算被停用', async () => {
    await render([row({ closedNow: { why: '上游高峰时段涨价', resumesAt: '2026-09-10T10:00:00.000Z', minutesLeft: 45 } })]);
    expect(text()).toContain('关门中');
    expect(text()).toContain('18:00 恢复');       // UTC 10:00 = 北京 18:00
    expect(text()).not.toContain('已停用');
    expect(toggleBtn().textContent).toContain('停用');   // 关门是上游的事，闸还在开着
  });

  it('被站主停用的行：标「已停用」，按钮翻成「启用」', async () => {
    await render([row({ enabled: false, switchedBy: 'u_admin' })]);
    expect(text()).toContain('已停用');
    expect(toggleBtn().textContent).toContain('启用');
  });

  it('点停用：发 PATCH {enabled:false}，上游回的牵连提醒要落到 toast 上', async () => {
    await render([row({ usedAsFastBy: ['glm-5.3-flash-merge'] })]);
    patchModel.mockResolvedValue({ model: row({ enabled: false }), warning: '还被这些行当 helper / 备用行：glm-5.3-flash-merge' });
    await act(async () => { toggleBtn().click(); });
    expect(patchModel).toHaveBeenCalledWith('deepseek-v4.1-flash-merge', { enabled: false });
    expect(useGlobalStore.getState().toasts.map(t => t.msg).join('\n')).toContain('helper');
  });

  it('内部行（helper）默认折起来，展开才出现 —— 选择器里没有它们，别跟可选行混在一起', async () => {
    await render([row(), row({ id: 'deepseek-v4-flash-helper', label: null, selectable: false, unavailable: null })]);
    expect(text()).toContain('内部行（1）');
    expect(text()).not.toContain('deepseek-v4-flash-helper');
    const expand = [...host.querySelectorAll('button')].find(b => b.textContent.includes('内部行'));
    await act(async () => { expand.click(); });
    expect(text()).toContain('deepseek-v4-flash-helper');
  });
});

describe('关门时段的设置入口（内置行也能改）', () => {
  const openEditor = async () => {
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('关门时段'));
    await act(async () => { btn.click(); });
  };
  const box = (ph) => [...host.querySelectorAll('input')].find((i) => i.placeholder === ph);
  const click = async (label) => {
    const b = [...host.querySelectorAll('button')].find((x) => x.textContent === label);
    await act(async () => { b.click(); });
  };
  const type = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('每行都有入口；打开后按现有时段回填', async () => {
    await render([row()]);
    await openEditor();
    expect(box('01:00-04:00, 06:00-10:00').value).toBe('01:00-04:00, 06:00-10:00');
  });

  it('保存：PATCH {unavailable:{windows,tz,why}}，不带 enabled（改时段不动开关）', async () => {
    await render([row()]);
    await openEditor();
    type(box('01:00-04:00, 06:00-10:00'), '06:00-10:00');
    type(box('关门的理由（用户看得到）'), '只关早上那段');
    patchModel.mockResolvedValue({ model: row() });
    await click('保存');
    expect(patchModel).toHaveBeenCalledWith('deepseek-v4.1-flash-merge', { unavailable: { windows: ['06:00-10:00'], tz: 'UTC', why: '只关早上那段' } });
    expect(patchModel.mock.calls[0][1]).not.toHaveProperty('enabled');
  });

  it('「不关门」发 null（明确取消，不是没设过）；出厂那份还留着当参照', async () => {
    await render([row()]);
    await openEditor();
    patchModel.mockResolvedValue({ model: row() });
    await click('不关门');
    expect(patchModel).toHaveBeenCalledWith('deepseek-v4.1-flash-merge', { unavailable: null });
  });

  it('没改过的行不给「恢复默认」（没东西可恢复）', async () => {
    await render([row({ unavailableSource: 'row' })]);
    await openEditor();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '恢复默认')).toBe(false);
    expect(text()).not.toContain('你改过');
  });

  it('站主改过的行：行上标「你改过」，编辑器里多一个「恢复默认」', async () => {
    await render([row({ unavailableSource: 'admin', builtinUnavailable: { windows: ['01:00-04:00', '06:00-10:00'] } })]);
    expect(text()).toContain('你改过');
    await openEditor();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '恢复默认')).toBe(true);
    patchModel.mockResolvedValue({ model: row() });
    await click('恢复默认');
    expect(patchModel).toHaveBeenCalledWith('deepseek-v4.1-flash-merge', { unavailable: 'reset' });
  });

  it('被取消关门的行：行上说清楚出厂本来是几点（不然没人记得改过什么）', async () => {
    await render([row({ unavailable: null, unavailableSource: 'admin', builtinUnavailable: { windows: ['01:00-04:00'], tz: 'UTC' } })]);
    expect(text()).toContain('取消了');
    expect(text()).toContain('01:00-04:00');
  });
});

describe('站点自己加的模型（复用 SlotEditor）', () => {
  it('那一节在页面上，措辞是"当场生效"不是"重启"', async () => {
    await render([row()]);
    expect(text()).toContain('站点自己加的模型');
    expect(text()).toContain('当场生效');
    expect(text()).not.toContain('重启后生效');   // 本地那份的措辞，站点这边不该出现
  });

  it('服务商下拉里有站内已有的上游（站主不用把网关连钥匙再声明一遍）', async () => {
    modelSlots.mockResolvedValue({ ...SLOTS, raw: { upstreams: {}, models: [{ id: 'x', label: 'X', window: 128000, upstream: 'merge', wireModel: 'a/b' }] }, activeExternalModels: ['x'] });
    await render([row()]);
    const opts = [...host.querySelectorAll('option')].map(o => o.textContent);
    expect(opts).toContain('Merge Gateway');
  });

  it('保存：把整份配置 PUT 上去，然后把上面那张总闸清单也重新拉一遍', async () => {
    modelSlots.mockResolvedValue({ ...SLOTS, raw: { upstreams: {}, models: [{ id: 'x', label: 'X', window: 128000, upstream: 'merge', wireModel: 'a/b' }] } });
    await render([row()]);
    saveModelSlots.mockResolvedValue({ ok: true, errors: [], activeExternalModels: ['x'] });
    const before = models.mock.calls.length;
    const saveBtn = [...host.querySelectorAll('button')].find(b => /保存/.test(b.textContent));
    await act(async () => { saveBtn.click(); });
    expect(saveModelSlots).toHaveBeenCalledWith({ upstreams: {}, models: [{ id: 'x', label: 'X', window: 128000, upstream: 'merge', wireModel: 'a/b' }] });
    expect(models.mock.calls.length).toBeGreaterThan(before);   // 新行要出现在总闸清单里
  });
});
