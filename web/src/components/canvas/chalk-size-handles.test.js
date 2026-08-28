// 板书高度手柄的地板（2026-08-28 用户实报「拉高之后没办法缩回去，会被阻拦」）
//
// 留白是用 minHeight 实现的 —— 于是「量一下正文多高」这件事有个陷阱：
// minHeight 一生效，量到的高**就是留白本身**。拿它当下限就是个自反馈的棘轮：
//   拖到 200 → 存 h=200 → minHeight:200 → 下次量还是 200 → 下限=200 → 再也下不去
// 这里用一个**行为像浏览器的假元素**（高度 = max(内容高, minHeight)）把它钉死；
// happy-dom 没有真布局引擎，量不出这个 bug，所以判据建在这个假元素上而不是 DOM 上。
import { describe, it, expect } from 'vitest';
import { naturalHeightOf } from './ChalkSizeHandles.jsx';

/** @param contentH 正文真正占多高 */
function fakeEl(contentH, minHeight = '') {
  const el = {
    style: { minHeight },
    getBoundingClientRect() {
      const floor = parseFloat(this.style.minHeight) || 0;
      return { height: Math.max(contentH, floor) };
    },
  };
  return el;
}

describe('量正文自然高度', () => {
  it('没留白时就是正文高', () => {
    expect(naturalHeightOf(fakeEl(100), 1)).toBe(100);
  });

  it('⭐ 留白生效时量到的仍是正文高 —— 不是留白（棘轮就出在这）', () => {
    expect(naturalHeightOf(fakeEl(100, '200px'), 1)).toBe(100);
  });

  it('⭐ 拉高三次，地板一次都不许跟着抬', () => {
    const floors = ['', '200px', '400px', '900px'].map((mh) => naturalHeightOf(fakeEl(100, mh), 1));
    expect(floors).toEqual([100, 100, 100, 100]);
  });

  it('量完把 minHeight 原样还原（不能顺手把留白抹了）', () => {
    const el = fakeEl(100, '200px');
    naturalHeightOf(el, 1);
    expect(el.style.minHeight).toBe('200px');
    const bare = fakeEl(100);
    naturalHeightOf(bare, 1);
    expect(bare.style.minHeight).toBe('');
  });

  it('镜头缩放换算成世界单位', () => {
    expect(naturalHeightOf(fakeEl(200, '600px'), 2)).toBe(100);
  });

  it('元素找不到时给 0，不炸（拖到一半卡被删）', () => {
    expect(naturalHeightOf(null, 1)).toBe(0);
  });
});
