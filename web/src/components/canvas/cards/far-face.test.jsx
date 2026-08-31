// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import BoardObject from './BoardObject.jsx';

/**
 * 分级渲染的**运行时证据**：真挂一次 React 树，看远处那张卡上到底有什么。
 *
 * 判据在 lib/board-lod.test.js 那边已经钉了（阈值、闸只有一处），这里只回答
 * 纯函数回答不了的那一半：内容真的没画、名字真的画出来了、字号真的被顶回了
 * 物理尺寸。⭐ 最后那条尤其只有真渲染看得见 —— 反缩算错的话，测试里那些
 * `lodOf` 断言一条都不会红，画布上却是一片看不见的小字。
 */
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const NOTE = {
  id: 'notes/线索板.md', type: 'note', title: '线索板',
  text: '第一条线索：门锁没有撬动痕迹', chalk: true,
};
const render = (o, scale) => {
  act(() => root.render(
    <BoardObject o={{ ...o, pos: { x: 0, y: 0, z: 1 } }} projectId="p1" fileVersions={{}} scale={scale} />,
  ));
  return host;
};

describe('拉远之后卡上画什么', () => {
  it('100% 上画内容，名字不冒出来', () => {
    const el = render(NOTE, 1);
    expect(el.textContent).toContain('门锁没有撬动痕迹');
    expect(el.querySelector('[data-text-body]'), '正常缩放下内容体应该在').toBeTruthy();
  });

  it('⭐ 缩到读不了的时候：内容整块不画，改画名字', () => {
    const el = render(NOTE, 0.3);   // 200 宽 × 0.3 = 60px，label 档
    expect(el.querySelector('[data-text-body]'), '远处还在渲染内容体').toBeFalsy();
    expect(el.textContent, '远处没画名字，那就是一张空白块').toContain('线索板');
  });

  it('⭐⭐ 字被反缩顶回了物理尺寸（算错的话纯函数判据一条都不会红）', () => {
    const el = render(NOTE, 0.25);
    const face = el.querySelector('[aria-hidden]');
    expect(face).toBeTruthy();
    // 世界层整体缩 0.25，这张脸自己 scale(4)，两者相乘 = 1，字号就是它写的那个数
    expect(face.style.transform).toBe('scale(4)');
    // 盒子按"渲染像素"给：200 × 0.25 = 50，再被 scale(4) 顶回去 = 屏幕上 50px
    expect(face.style.width).toBe('50px');
  });

  it('窄到连词都认不出：不画字了', () => {
    const el = render(NOTE, 0.15);   // 200 × 0.15 = 30px，blank 档
    expect(el.textContent, 'blank 档还在画字').not.toContain('线索板');
  });

  /**
   * ⛔ 这一条是**截图看出来的**，不是想出来的：板书没有卡片外观，blank 档一律
   * 返回 null 的话它在全貌上整个消失，而板书恰恰是板上字最多的那一类。
   * 纯函数判据和「元素在不在」的断言都不会红 —— 那个元素确实"正确地"没渲染。
   */
  it('⭐ 墨类在 blank 档要补一块色 —— 否则全貌上写字最多的地方是一片空白', () => {
    const el = render(NOTE, 0.15);
    const blank = el.querySelector('[data-far-blank]');
    expect(blank, '板书在最远处整个消失了').toBeTruthy();
    expect(blank.style.background, '补的那块得有颜色').toMatch(/rgba?\(/);
  });

  it('有卡片外观的形态不补 —— 它自己的底色和边框已经在了', () => {
    const el = render({ id: '素材/a.md', type: 'file', name: 'a.md' }, 0.1);
    expect(el.querySelector('[data-far-blank]'), '给有卡的又补了一层').toBeFalsy();
  });

  it('涂鸦豁免：缩到多小都还画那笔画', () => {
    const el = render({ id: 'ink1', type: 'scribble', data: { d: 'M0 0 L50 50' } }, 0.2);
    expect(el.querySelector('svg path'), '涂鸦被换成名字了 —— 它在形态表里是豁免的').toBeTruthy();
  });
});
