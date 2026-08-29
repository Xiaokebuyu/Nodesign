// @vitest-environment happy-dom
/**
 * json 键值树显示器（2026-08-29 占位契约刀 B，站主点名）。
 *
 * 钉三件：结构画得出来、折叠能收能开、**不是合法 json 就老实退回等宽原样**
 * （最后这条最要紧 —— 假装看得懂比不显示更糟）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import JsonInk from './JsonInk.jsx';

let host; let root;
function render(text) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<JsonInk text={text} />); });
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

describe('JsonInk', () => {
  it('⭐ 画出键名和标量值', () => {
    const el = render('{"name":"灰","count":3,"on":true,"none":null}');
    const t = el.textContent;
    expect(t).toContain('name');
    expect(t).toContain('灰');
    expect(t).toContain('3');
    expect(t).toContain('true');
    expect(t).toContain('null');
  });

  it('⭐ 分支可折叠：点一下收起，再点展开', () => {
    const el = render('{"cfg":{"deep":"里面的值"}}');
    expect(el.textContent).toContain('里面的值');
    const branch = el.querySelector('[data-json-row="cfg"]');
    act(() => { branch.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).not.toContain('里面的值');
    act(() => { branch.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('里面的值');
  });

  it('数组显示条数', () => {
    const el = render('{"xs":[1,2,3]}');
    expect(el.textContent).toMatch(/xs/);
    expect(el.textContent).toMatch(/1/);
  });

  it('⭐ 不是合法 json → 退回等宽原样，不假装看得懂', () => {
    const el = render('{ 半行就没了');
    expect(el.querySelector('pre')).toBeTruthy();
    expect(el.textContent).toContain('半行就没了');
  });

  it('空输入不炸', () => {
    expect(() => render('')).not.toThrow();
  });
});
