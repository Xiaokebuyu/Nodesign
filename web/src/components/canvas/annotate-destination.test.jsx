// @vitest-environment happy-dom
/**
 * 标注去向：显示的和实际发的必须是同一件事（2026-08-28 用户拍板「把去向变成看得见的」）。
 *
 * 仓库里早就写着这条的反面代价：「文案说"说给墨璃"而实际发给了主控，比不显示更糟」。
 * 所以这里钉的不是"有没有开关"，是**开关拨到哪，标签和 onSubmit 的载荷就得一起动**。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import AnnotatePopover from './AnnotatePopover.jsx';

const target = { id: 'notes/板书/a.md', title: '第一章', typeLabel: '板书' };
const roleTarget = { who: '泉此方', slug: 'rp-izumi' };

let host; let root;
function render(props) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<AnnotatePopover x={10} y={10} target={target} onClose={() => {}} {...props} />);
  });
  // ⚠️ 浮层走 createPortal 挂到 document.body 上 —— 断言容器得是 body 不是挂载点
  // （第一版对着 host 断言，四条全是 textContent==''，判据自己先坏了）
  return document.body;
}
const click = (el) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const chip = (el, label) => [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
// ⚠️ React 的受控 textarea 不认直接赋 value —— 要走原生 setter 才触发 onChange
const type = (el, v) => act(() => {
  const ta = el.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

describe('去向开关', () => {
  it('角色写的板书：默认说给它，标签和按钮都这么写', () => {
    expect(render({ roleTarget }).textContent).toContain('说给泉此方');
  });

  it('⭐ 拨到「主控」→ 标签跟着改，载荷也跟着改（说的=做的）', () => {
    const onSubmit = vi.fn();
    const el = render({ roleTarget, onSubmit });
    click(chip(el, '主控'));
    expect(el.textContent).toContain('发给 agent');
    expect(el.textContent).not.toContain('说给泉此方');
    type(el, '这段能不能重写');
    click([...el.querySelectorAll('button')].find((b) => /发给 agent/.test(b.textContent)));
    expect(onSubmit).toHaveBeenCalledWith('这段能不能重写', { toMain: true });
  });

  it('拨回角色 → 载荷回到直达', () => {
    const onSubmit = vi.fn();
    const el = render({ roleTarget, onSubmit });
    click(chip(el, '主控'));
    click(chip(el, '泉此方'));
    type(el, '你还好吗');
    click([...el.querySelectorAll('button')].find((b) => /说给泉此方/.test(b.textContent)));
    expect(onSubmit).toHaveBeenCalledWith('你还好吗', { toMain: false });
  });

  it('不是角色写的东西：没有第二个去处，不出开关', () => {
    const el = render({});
    expect(chip(el, '主控')).toBeUndefined();
    expect(el.textContent).toContain('标注 · 板书「第一章」');
  });
});
