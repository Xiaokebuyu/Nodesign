// @vitest-environment happy-dom
/**
 * 遮挡图对「松动的纸」（揭页复制品）的三条纪律，见 home-occluders.js 文件头 LOOSE 那段：
 *   1. 起飞时跟叠一样高，转过去才抬高
 *   2. 淡出时 alpha 跟着淡
 *   3. g 通道打标；复制品不再被 .ndd-pad 那条重复收进来
 *
 * 判据长在画出来的像素上（fillStyle / fillRect 的调用），不是长在返回值上 ——
 * 09-05 之前这三件事全部"测试全绿、截图里一块黑影"。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeOccluders } from './home-occluders.js';

let calls, styles;
beforeEach(() => {
  calls = [];
  styles = new Map();
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
    set fillStyle(v) { calls.push({ fill: v }); },
    fillRect(x, y, w, h) { calls[calls.length - 1].rect = [x, y, w, h]; },
  });
  vi.stubGlobal('getComputedStyle', (el) => styles.get(el) || { transform: 'none', opacity: '1' });
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  document.body.innerHTML = '';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** 造一个能量出矩形的元素 */
function box(cls, { left = 100, top = 100, width = 300, height = 120, parent = document.body, tag = 'div', bbox } = {}) {
  const el = document.createElement(tag);
  el.className = cls;
  parent.append(el);
  const b = bbox || { left, top, width, height };
  el.getBoundingClientRect = () => ({ ...b, right: b.left + b.width, bottom: b.top + b.height });
  Object.defineProperty(el, 'offsetWidth', { value: width });
  Object.defineProperty(el, 'offsetHeight', { value: height });
  return el;
}
/** 一叠输入纸 + 正被揭掉的复制品（带自己那两片签） */
function desk({ transform = 'none', opacity = '1' } = {}) {
  const stack = box('ndd-stack', { width: 720, height: 200 });
  const tabs = box('nd-tabs', { parent: stack, width: 130, height: 36 });
  box('on', { parent: tabs, tag: 'button', width: 64, height: 36 });
  box('', { parent: tabs, tag: 'button', width: 64, height: 36, left: 164 });
  const pad = box('ndd-pad design', { parent: stack, width: 720, height: 160 });
  const peel = box('ndd-pad rp ndd-peel', { parent: stack, width: 720, height: 160 });
  const peelTabs = box('nd-tabs', { parent: peel, width: 130, height: 36 });
  box('on', { parent: peelTabs, tag: 'span', width: 64, height: 36 });
  box('', { parent: peelTabs, tag: 'span', width: 64, height: 36, left: 164 });
  styles.set(peel, { transform, opacity });
  return { pad, peel };
}
const red = (fill) => Number(fill.match(/rgba\((\d+),/)[1]);
const green = (fill) => Number(fill.match(/rgba\(\d+,(\d+),/)[1]);
const alpha = (fill) => Number(fill.match(/,([\d.]+)\)$/)[1]);
/**
 * 画出来的每一笔按角色认出来（画的顺序是按高度排的，不能按表的顺序取下标）：
 * 宽的是纸（720），窄的是签（64）；g=255 是松动的纸；两片真签里红得高的是选中那片。
 */
function paint() {
  makeOccluders(500, 400).update();
  const wide = (c) => Math.abs(c.rect[2]) > 100;
  const r = {};
  r.pad = calls.find((c) => wide(c) && green(c.fill) === 0);
  r.peel = calls.find((c) => wide(c) && green(c.fill) === 255);
  r.peelTab = calls.find((c) => !wide(c) && green(c.fill) === 255);
  const tabs = calls.filter((c) => !wide(c) && green(c.fill) === 0).sort((a, b) => red(b.fill) - red(a.fill));
  [r.on, r.off] = tabs;
  return r;
}

it('复制品只画一次，不再被 .ndd-pad 那条重复收进来', () => {
  desk();
  paint();
  // 叠、复制品、复制品的签、真签两片 = 5 笔；从前复制品被画两次是 6 笔
  expect(calls).toHaveLength(5);
});

it('起飞那一瞬复制品跟叠一样高，影子才不会先长一截', () => {
  desk({ transform: 'matrix(1, 0, 0, 1, 0, 0)' });
  const { pad, peel } = paint();
  expect(red(peel.fill)).toBe(red(pad.fill));
  expect(alpha(peel.fill)).toBe(1);
  expect(green(pad.fill)).toBe(0);
  expect(green(peel.fill)).toBe(255);   // 松动的纸：着色器按抬起的那一截算它投到纸上的影子
});

it('转过去才抬高：转满 0.35 弧度抬到 2.5', () => {
  // 23° ≈ 0.40 弧度，超过 LIFT_AT，抬满
  desk({ transform: 'matrix(0.9205, 0.3907, -0.3907, 0.9205, 96, 168)' });
  const { pad, peel } = paint();
  // 同一个抖动系数下，2.5 / 2.2 = 1.136
  expect(red(peel.fill) / red(pad.fill)).toBeCloseTo(2.5 / 2.2, 2);   // 从前是 2.4/2.2=1.09，1 位小数分不开
});

it('淡出时影子跟着淡：alpha 写的是宿主的 opacity', () => {
  desk({ transform: 'matrix(0.9205, 0.3907, -0.3907, 0.9205, 96, 168)', opacity: '0.109' });
  const { pad, peel, peelTab } = paint();
  expect(alpha(peel.fill)).toBeCloseTo(0.109, 3);
  expect(alpha(peelTab.fill)).toBeCloseTo(0.109, 3);   // 它自己那片签（opacity 挂在宿主上，读自己会读成 1）
  expect(alpha(pad.fill)).toBe(1);                      // 叠不受影响
});

it('复制品那片签跟它同高同转角；真签两片照旧一高一矮、不淡', () => {
  desk({ transform: 'matrix(0.9205, 0.3907, -0.3907, 0.9205, 96, 168)', opacity: '0.5' });
  const { peel, peelTab, on, off } = paint();
  expect(red(peelTab.fill)).toBe(red(peel.fill));
  expect(green(peelTab.fill)).toBe(255);
  expect(alpha(on.fill)).toBe(1);
  expect(alpha(off.fill)).toBe(1);
  expect(red(on.fill)).toBeGreaterThan(red(off.fill));
  expect(green(on.fill)).toBe(0);
});

it('复制品动一帧、淡一点，签名都得变，否则纹理不会重传', () => {
  desk({ transform: 'matrix(1, 0, 0, 1, 0, 0)' });
  const o = makeOccluders(500, 400);
  const v0 = o.update().version;
  expect(o.update().version).toBe(v0);                       // 什么都没动
  const peel = document.querySelector('.ndd-peel');
  styles.set(peel, { transform: 'matrix(1, 0, 0, 1, 0, 0)', opacity: '0.6' });
  const v1 = o.update().version;
  expect(v1).toBe(v0 + 1);                                    // 只淡了一点，矩形没动
  styles.set(peel, { transform: 'matrix(0.99, 0.14, -0.14, 0.99, 0, 0)', opacity: '0.6' });
  expect(o.update().version).toBe(v1 + 1);                    // 只转了一点
});

it('按高度从低到高画：没选中那片签叠在纸上沿的那 12px 归纸，不归签', () => {
  desk();
  paint();
  const fills = calls.map((c) => ({ h: red(c.fill), wide: Math.abs(c.rect[2]) > 100 }));
  for (let k = 1; k < fills.length; k++) expect(fills[k].h).toBeGreaterThanOrEqual(fills[k - 1].h);
  // 最矮的那片签第一笔，纸在它后面 —— 叠在一起的那一条最后留下的是纸的高度
  expect(fills[0].wide).toBe(false);
});
