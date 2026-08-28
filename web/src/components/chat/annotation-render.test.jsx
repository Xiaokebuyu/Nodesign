// @vitest-environment happy-dom
/**
 * 画布标注在侧边栏里长什么样（2026-08-28 用户实报）。
 *
 * 用户报「发送标注的内容，其完整的附加内容都会被显示在侧边栏中」——
 * 路径、作者、原文摘录、reply_to 指令一整条原样铺在气泡里，他自己那句话淹在里面。
 *
 * 这里钉两件（都是"看得见的东西"，parser 的单测不覆盖）：
 *   ① 默认只显示用户自己的话，机械那半不在可见文本里
 *   ② 那半没有被丢掉 —— 点开能看全（发给 agent 的内容本来就一个字没动）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Message from './Message.jsx';

const REAL = '【画布标注】板书「20260828-192124-第一章-放学后.md」（notes/板书/20260828-192124-第一章-放学后.md），agent 写的，原文「# 第一章 · 放学后 八月的尾巴还挂在下午五点半的天上。」；回应请 write_on_board reply_to=notes/板书/20260828-192124-第一章-放学后.md：按下怀表';

let host; let root;
function render(content) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<Message message={{ role: 'user', content }} />); });
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

describe('画布标注消息', () => {
  it('⭐ 默认只显示用户自己那句，机械不铺在气泡里', () => {
    const el = render(REAL);
    const txt = el.textContent;
    expect(txt).toContain('按下怀表');
    expect(txt, '路径不该出现在收起态').not.toContain('notes/板书/');
    expect(txt, 'reply_to 指令不该给人看').not.toContain('reply_to=');
    expect(txt, '原文摘录不该铺开').not.toContain('八月的尾巴');
  });

  it('折起来那行小字说清标了什么（文件名去掉时间戳）', () => {
    expect(render(REAL).textContent).toContain('标注 · 板书「第一章-放学后」');
  });

  it('⭐ 点开能看全 —— 折叠只是显示，内容一个字没丢', () => {
    const el = render(REAL);
    act(() => { el.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const txt = el.textContent;
    expect(txt).toContain('reply_to=');
    expect(txt).toContain('八月的尾巴');
  });

  it('普通消息一如既往（不是标注就别动它）', () => {
    const el = render('这是一句普通的话：带冒号');
    expect(el.textContent).toContain('这是一句普通的话：带冒号');
    expect(el.textContent).not.toContain('标注');
  });
});
