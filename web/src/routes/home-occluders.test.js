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

let calls, styles, op;
beforeEach(() => {
  calls = [];
  styles = new Map();
  op = 'source-over';
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
    set fillStyle(v) { calls.push({ fill: v, op }); },
    // ⭐ 合成方式也记下来：画框遮罩靠 `lighten` 才能只抬蓝色通道而不动纸的几何，
    //   记不下来的话「用没用对合成方式」就没有判据（见 home-occluders.js 的 CHROME）。
    set globalCompositeOperation(v) { op = v; },
    // 一支笔画多个矩形（画框那一遍就是）：每个矩形各记一笔，别互相覆盖
    fillRect(x, y, w, h) {
      let e = calls[calls.length - 1];
      if (e.rect) { e = { fill: e.fill, op: e.op }; calls.push(e); }
      e.rect = [x, y, w, h];
    },
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

it('复制品那片签跟它同高同转角；真签两片跟纸同高、不淡', () => {
  desk({ transform: 'matrix(0.9205, 0.3907, -0.3907, 0.9205, 96, 168)', opacity: '0.5' });
  const { pad, peel, peelTab, on, off } = paint();
  expect(red(peelTab.fill)).toBe(red(peel.fill));
  expect(green(peelTab.fill)).toBe(255);
  expect(alpha(on.fill)).toBe(1);
  expect(alpha(off.fill)).toBe(1);
  // 两片都跟纸同高：纸投不到它们身上（夜里灯的落脚点就在纸上沿边上，矮一截的那片会接到
  // 纸往上甩的影子）。一高一矮的观感归 CSS 的受光层。
  expect(red(on.fill)).toBe(red(pad.fill));
  expect(red(off.fill)).toBe(red(pad.fill));
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
});

it('比纸矮的东西叠在纸里的那一条归纸：矮的先画', () => {
  desk();
  // 造一片比纸矮的签（表里现在没有矮的了，用一条临时低高度验证画序本身）
  const low = box('ndd-card', { width: 300, height: 200, left: 120, top: 120 });
  const a = box('', { parent: low, tag: 'a', width: 300, height: 200, left: 120, top: 120 });
  void a;
  paint();
  const fills = calls.map((c) => ({ h: red(c.fill), wide: Math.abs(c.rect[2]) > 100 }));
  expect(fills[0].h).toBeLessThan(fills[fills.length - 1].h);   // 卡片（1.0）第一笔，纸（2.2）在后
});

// ── 画框遮罩（CHROME）────────────────────────────────────────────
/**
 * 造一个真实形状的外壳：顶栏一条 + 底下那个 overflow:auto 的滚动容器 + 台面。
 * 首页就是这个形状（AppShell 的非 overlayTop 那条），顶栏长在滚动区**外面**。
 */
function shell({ barH = 56, vw = 1000, vh = 800 } = {}) {
  const host = box('nd-shell', { bbox: { left: 0, top: 0, width: vw, height: vh } });
  const scroll = box('scroll', { parent: host, bbox: { left: 0, top: barH, width: vw, height: vh - barH } });
  styles.set(scroll, { transform: 'none', opacity: '1', overflowY: 'auto' });
  return box('ndd', { parent: scroll, bbox: { left: 0, top: barH, width: vw, height: 3000 } });
}
/** 画框那几笔（蓝色通道，lighten） */
const chromeCalls = () => calls.filter((c) => c.op === 'lighten');

it('⭐⭐⭐ 顶栏那条带子自动进画框遮罩 —— 长在滚动区外面的东西不用谁去登记', () => {
  const ndd = shell({ barH: 56 });
  makeOccluders(500, 400, { host: ndd }).update();
  const band = chromeCalls().find((c) => c.rect[3] > 0 && c.rect[1] === 0 && c.rect[2] === 500);
  expect(band, '滚动区上面那条（顶栏）没进遮罩').toBeTruthy();
  // 视口 1000x800 画进 500x400，顶栏 56 → 28
  expect(band.rect).toEqual([0, 0, 500, 28]);
  expect(band.fill, '遮罩要打在蓝色通道上').toMatch(/rgba\(0,0,255,1\)/);
});

it('⭐⭐⭐ 遮罩不动几何：顶栏底下压着的那半截纸，红/绿/alpha 一个都没被改', () => {
  // ⛔ 这是第一版的病：把顶栏当遮挡物写进**高度通道**，顶栏底下那半截输入纸
  //   就被从几何里抹掉了 —— 夜里台灯投出来的影子整片改向（实测台面均值差 4.07
  //   灰阶、23% 的像素）。物理上顶栏是挡在你和桌子之间的画框，不参与光路。
  const ndd = shell({ barH: 56 });
  // 一叠输入纸，上半截滚进顶栏底下（top 为负）
  box('ndd-pad', { parent: ndd, bbox: { left: 200, top: -40, width: 600, height: 200 } });
  makeOccluders(500, 400, { host: ndd }).update();
  const pad = calls.find((c) => c.op !== 'lighten' && Math.abs(c.rect[2]) > 100);
  expect(pad, '纸没画进去').toBeTruthy();
  expect(pad.rect, '纸的矩形被顶栏截掉了').toEqual([100, -20, 300, 100]);
  expect(alpha(pad.fill)).toBe(1);
  expect(red(pad.fill), '纸的高度被改了').toBeGreaterThan(0);
  // 画框必须**最后**画：先画的话纸会把蓝色通道盖回 0
  const lastPaper = calls.findLastIndex((c) => c.op !== 'lighten');
  const firstChrome = calls.findIndex((c) => c.op === 'lighten');
  expect(firstChrome, '画框要在所有纸之后画').toBeGreaterThan(lastPaper);
});

it('浮在台面上方、z 又没爬过光源层的那些，带 data-nd-chrome 就进遮罩', () => {
  const ndd = shell();
  const banner = box('banner', { parent: ndd, bbox: { left: 220, top: 8, width: 560, height: 48 } });
  banner.setAttribute('data-nd-chrome', '');
  makeOccluders(500, 400, { host: ndd }).update();
  const hit = chromeCalls().find((c) => c.rect[2] === 280);
  expect(hit, '横幅没进遮罩').toBeTruthy();
  expect(hit.rect).toEqual([110, 4, 280, 24]);
});

it('顶栏高度变了，版本号得跟着变，否则遮罩不会重传', () => {
  // ⚠️ 同族教训：签名漏了哪一项，那一项改了画面就不重画（遮挡图这边栽过一次）
  const ndd = shell({ barH: 56 });
  const occl = makeOccluders(500, 400, { host: ndd });
  const a = occl.update();
  expect(occl.update().version, '什么都没动却重画了').toBe(a.version);
  const scroll = ndd.parentElement;
  scroll.getBoundingClientRect = () => ({ left: 0, top: 44, width: 1000, height: 756, right: 1000, bottom: 800 });
  expect(occl.update().version, '顶栏矮了 12px，遮罩没跟着变').toBeGreaterThan(a.version);
});

it('没有台面（host 没给）时一笔遮罩都不画 —— 别的页面不受这条影响', () => {
  desk();
  makeOccluders(500, 400).update();
  expect(chromeCalls()).toHaveLength(0);
});
