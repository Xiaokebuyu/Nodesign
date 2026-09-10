// @vitest-environment happy-dom
/**
 * 设置页「加一行模型」不许崩（2026-09-02）。
 *
 * npm 0.0.8 的本地版里，模型行一渲染就 `t is not a function`（回调参数把 i18n 的 t
 * 遮了，见 lib/i18n-shadow.lint.test.js），整条 /settings 路由被错误边界接管。
 * 用户点「② 模型 · 加一行」= 白屏，BYOK 那条线上配不出模型来。
 *
 * lint 钉的是"遮蔽这件事不许再发生"；这个文件钉的是**结果**：
 * 有模型行的设置页要能渲染出来。两条各管一半 ——
 * 遮蔽只是这一行崩掉的一种成因，换个成因（少传 enums、字段改名）lint 照样绿。
 *
 * ⚠️ 枚举从 **server/runtime/local-config.js 的 CONFIG_ENUMS 直接取**，
 * 不在这儿抄一份：崩的那一支是 `thinking === 'strip'`，抄一份就等于把
 * "线上真会传 'strip'" 这个前提替换成"我记得它传 'strip'"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import SlotEditor from './SlotEditor.jsx';
import { CONFIG_ENUMS } from '../../../../server/runtime/local-config.js';

const UPSTREAM = { baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', key: 'sk-x', label: 'DeepSeek 官方' };
/** 「加一行」新建出来的那一行长这样（SlotEditor 的 EMPTY_MODEL + 自动挑的上游） */
const FRESH_ROW = { id: '', label: '', window: 128000, upstream: 'deepseek', wireModel: '' };

/**
 * ⚠️ 不开这个开关，`act()` 只警告不同步刷新 —— 第一版的表现是 textContent 停在
 * 上游那张卡，模型行"看起来没渲染"。**那是量具没跑完，不是组件的问题**：
 * 真崩的时候它同样什么都不显示，两种情况长得一模一样。开关放在这个文件里，
 * 不动 test-setup.js（那是全局的）。
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host, root, errors;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // React 把渲染期的异常报到 console.error 后再抛给错误边界 —— 没边界时 act 会抛，
  // 但顺手也把 console 收了，免得真崩时刷屏盖住断言。
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

function render(models, props = {}) {
  const config = { upstreams: { deepseek: UPSTREAM }, models };
  act(() => root.render(
    <SlotEditor config={config} setConfig={() => {}} errors={[]} enums={CONFIG_ENUMS}
      active={[]} needsRestart={false} onSave={() => {}} saving={false} showToast={() => {}} {...props} />,
  ));
  return host.textContent;
}
/** ⚠️ 填进去的字（显示名、模型名）在 input.value 里，**不在 textContent 里** */
const inputValues = () => [...host.querySelectorAll('input')].map((i) => i.value);
/**
 * 崩的那一句 `t('剥离（非 Claude 模型使用）')` 的产物。断言它在页面上 =
 * 直接证明那次调用返回了字符串，而不是"没抛异常所以大概没事"。
 */
const THINKING_STRIP_LABEL = '剥离（非 Claude 模型使用）';

describe('模型插槽编辑器', () => {
  it('⛔ 刚「加一行」出来的空模型行能渲染（0.0.8 就是死在这儿）', () => {
    expect(() => render([FRESH_ROW])).not.toThrow();
    expect(host.textContent, '模型那一节没画出来').toContain('② 模型');
    expect(host.textContent, 'thinking 那一列没画出来 —— 0.0.8 就是死在这个字符串上').toContain(THINKING_STRIP_LABEL);
  });

  it('⛔ 已经填好的模型行也能渲染', () => {
    const filled = { id: 'deepseek-chat', label: 'DeepSeek V3', window: 128000, upstream: 'deepseek', wireModel: 'deepseek-chat', thinking: 'strip', brand: 'deepseek' };
    expect(() => render([filled])).not.toThrow();
    expect(inputValues(), '填好的显示名/模型名没落到框里').toEqual(expect.arrayContaining(['DeepSeek V3', 'deepseek-chat']));
    expect(host.textContent).toContain(THINKING_STRIP_LABEL);
  });

  it('每一种 thinking 取值都渲染得出来', () => {
    // 崩的那一支是 'strip'，但判据别只钉那一个值 —— 三个都过一遍才说明这一列是好的
    for (const thinking of CONFIG_ENUMS.THINKING_MODES) {
      expect(() => render([{ ...FRESH_ROW, thinking }]), `thinking=${thinking} 渲染崩了`).not.toThrow();
    }
  });

  it('没有模型行时也是好的（0.0.8 里这条也绿 —— 所以它证明不了上面三条）', () => {
    expect(() => render([])).not.toThrow();
    expect(host.textContent).toContain('加一行');
  });

  it('渲染过程没有往 console.error 里吐东西', () => {
    render([FRESH_ROW]);
    expect(errors, `React 报了：\n${errors.join('\n')}`).toEqual([]);
  });
});

/**
 * 09-10 加的两处：站点管理台复用这个编辑器（applyMode='hot'），以及每行能声明"每天关门时段"。
 * 钉住的是**填进去的字变成什么形状** —— 这个字段填错不会当场报错，只会让那一行在服务端被静默丢掉。
 */
/**
 * 往受控输入框里"打字"。⚠️ 直接 `box.value = x` 再派发 input **不会**触发 React 的 onChange：
 * React 自己记着上一次的值，看见没变就不往下走（第一版就是这么假绿的）。要走原型上的 setter。
 */
const type = (box, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => { setter.call(box, value); box.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('站点场合与关门时段', () => {
  const rowWith = (over) => ({ id: 'x', label: 'X', window: 128000, upstream: 'deepseek', wireModel: 'deepseek-chat', ...over });

  it("applyMode='hot'：措辞是保存即可，不提重启", () => {
    render([rowWith({})], { applyMode: 'hot' });
    expect(host.textContent).toContain('未生效（保存即可）');
    expect(host.textContent).not.toContain('保存并重启');
  });

  it('canProbe=false 时不画「检测」按钮（站点那边还没有这个端点）', () => {
    render([rowWith({})], { canProbe: false, active: ['x'] });
    expect([...host.querySelectorAll('button')].some((b) => b.textContent.includes('检测'))).toBe(false);
    render([rowWith({})], { active: ['x'] });
    expect([...host.querySelectorAll('button')].some((b) => b.textContent.includes('检测'))).toBe(true);
  });

  it('内置上游进服务商下拉：站主不用把网关连钥匙再声明一遍', () => {
    render([rowWith({})], { builtinUpstreams: { merge: { label: 'Merge Gateway', keyPresent: true }, zen: { label: 'OpenCode Zen', keyPresent: false } } });
    const opts = [...host.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('Merge Gateway');
    expect(opts).toContain('OpenCode Zen（缺钥匙）');   // 没配钥匙的要写明，别让人挑完才发现发不出去
  });

  it('关门时段：逗号顿号空格都当分隔符，空了整个字段不写（不是空数组）', () => {
    let got;
    act(() => root.render(
      <SlotEditor config={{ upstreams: { deepseek: UPSTREAM }, models: [rowWith({})] }} setConfig={(c) => { got = c; }}
        errors={[]} enums={CONFIG_ENUMS} active={[]} needsRestart={false} onSave={() => {}} saving={false} showToast={() => {}} />,
    ));
    const box = [...host.querySelectorAll('input')].find((i) => i.placeholder === '01:00-04:00, 06:00-10:00');
    expect(box, '高级里那个关门时段输入框没画出来').toBeTruthy();
    type(box, '01:00-04:00、06:00-10:00');
    expect(got.models[0].unavailable).toEqual({ tz: 'UTC', windows: ['01:00-04:00', '06:00-10:00'] });
    type(box, '  ');
    expect(got.models[0].unavailable).toBeUndefined();
  });
});
