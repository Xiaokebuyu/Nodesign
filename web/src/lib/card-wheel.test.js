/**
 * card-wheel 单测（09-17，问题库 iss_mtuhruna_yg6c）。
 *
 * 钉两件事：
 *   1. 演出显示器那种「文档不滚、里面的容器滚」的页面，滚轮要找到里面的容器；
 *      滚不动时不吞，让画布平移（以前是吞了又没滚，两头都没反应）。
 *   2. 站点卡原有的行为不能坏：普通文档照旧滚视口，照旧走 scrollBy。
 *
 * 元素全是假对象：只有 scrollTop / scrollHeight / clientHeight / parentElement，
 * 样式挂在 `ov` 上，由假窗的 getComputedStyle 读出来。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WHEEL_LATCH_MS, hasRoomY, findWheelScroller, framePoint, wheelTargetInFrame,
  decideCardWheel, scrollTargetBy,
} from './card-wheel.js';

function mkEl(name, { ov = 'visible', top = 0, sh = 100, ch = 100 } = {}, parent = null) {
  return { name, ov, scrollTop: top, scrollHeight: sh, clientHeight: ch, parentElement: parent };
}

function mkDoc({ html, body, hit, scrollingElement = html }) {
  const win = { getComputedStyle: (el) => ({ overflowY: el.ov }) };
  return {
    defaultView: win,
    documentElement: html,
    body,
    scrollingElement,
    elementFromPoint: vi.fn(() => hit ?? null),
  };
}

/**
 * 演出显示器（server/engine/stage/display）的骨架：
 * html,body{height:100%}、body{overflow:hidden}；.cast 是 hidden，.cast-scroll / .beats /
 * .opening 是 overflow-y:auto；.opening .world 是 max-height + overflow:auto。
 */
function stageFixture({ beatsTop = 0, worldTop = 0, castSh = 400 } = {}) {
  const html = mkEl('html', { sh: 540, ch: 540 });
  const body = mkEl('body', { ov: 'hidden', sh: 540, ch: 540 }, html);
  const app = mkEl('app', {}, body);
  const main = mkEl('main', {}, app);
  const beats = mkEl('beats', { ov: 'auto', top: beatsTop, sh: 2000, ch: 496 }, main);
  const para = mkEl('p', {}, beats);
  const opening = mkEl('opening', { ov: 'auto', sh: 1500, ch: 496 }, main);
  const world = mkEl('world', { ov: 'auto', top: worldTop, sh: 700, ch: 330 }, opening);
  const worldText = mkEl('world-p', {}, world);
  const cast = mkEl('cast', { ov: 'hidden', sh: 496, ch: 496 }, app);
  const castScroll = mkEl('cast-scroll', { ov: 'auto', sh: castSh, ch: 480 }, cast);
  const mate = mkEl('mate', {}, castScroll);
  return { html, body, beats, para, opening, world, worldText, castScroll, mate };
}

/** 普通站点：文档自己滚（html / body 都是 visible），scrollingElement = html */
function siteFixture({ top = 0, sh = 3000 } = {}) {
  const html = mkEl('html', { top, sh, ch: 800 });
  const body = mkEl('body', { sh: sh - 16, ch: sh - 16 }, html);
  const section = mkEl('section', {}, body);
  const p = mkEl('p', {}, section);
  return { html, body, p };
}

describe('hasRoomY', () => {
  it('按方向判余量；不溢出 / dy=0 一律没有', () => {
    expect(hasRoomY({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 }, 10)).toBe(true);
    expect(hasRoomY({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 }, -10)).toBe(false);
    expect(hasRoomY({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 }, 10)).toBe(false);
    expect(hasRoomY({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 }, -10)).toBe(true);
    expect(hasRoomY({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }, 10)).toBe(false);
    expect(hasRoomY({ scrollTop: 10, scrollHeight: 500, clientHeight: 100 }, 0)).toBe(false);
  });

  it('缩放下到底差零点几像素也算到底（否则到头了还一直吞）', () => {
    expect(hasRoomY({ scrollTop: 399.5, scrollHeight: 500, clientHeight: 100 }, 10)).toBe(false);
    expect(hasRoomY({ scrollTop: 0.5, scrollHeight: 500, clientHeight: 100 }, -10)).toBe(false);
  });
});

describe('findWheelScroller —— 演出显示器（文档不滚，里面的容器滚）', () => {
  it('⭐ 指针在故事正文上往下滚：找到 .beats，不是视口', () => {
    const f = stageFixture();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.para }), 10, 10, 100)).toBe(f.beats);
  });

  it('⭐ .beats 滚到底再往下：没有目标（交还画布平移）；往上仍是 .beats', () => {
    const f = stageFixture({ beatsTop: 2000 - 496 });
    expect(findWheelScroller(mkDoc({ ...f, hit: f.para }), 10, 10, 100)).toBeNull();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.para }), 10, 10, -100)).toBe(f.beats);
  });

  it('⭐ 视口尺寸看着能滚也不算：body overflow:hidden 传播给了视口（08-14 滚的正是这个视口）', () => {
    const f = stageFixture({ beatsTop: 2000 - 496 });
    f.html.scrollHeight = 900;   // 视口往下还有 360px 的「余量」
    expect(findWheelScroller(mkDoc({ ...f, hit: f.para }), 10, 10, 100)).toBeNull();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.para }), 10, 10, -100)).toBe(f.beats);
  });

  it('指针在侧栏、名册不满一屏：一路往上都滚不动 → 没有目标', () => {
    const f = stageFixture();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.mate }), 10, 10, 100)).toBeNull();
  });

  it('侧栏名册溢出时滚侧栏，不去滚正文', () => {
    const f = stageFixture({ castSh: 1200 });
    expect(findWheelScroller(mkDoc({ ...f, hit: f.mate }), 10, 10, 100)).toBe(f.castScroll);
  });

  it('嵌套：内层（开场页的世界设定框）先滚，到底后链到外层 .opening', () => {
    const f = stageFixture();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.worldText }), 10, 10, 100)).toBe(f.world);
    const g = stageFixture({ worldTop: 700 - 330 });
    expect(findWheelScroller(mkDoc({ ...g, hit: g.worldText }), 10, 10, 100)).toBe(g.opening);
  });

  it('dy=0（纯横向）不找目标', () => {
    const f = stageFixture();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.para }), 10, 10, 0)).toBeNull();
  });
});

describe('findWheelScroller —— 站点卡原有行为（文档自己滚）', () => {
  it('⭐ 普通长页：目标是视口（scrollingElement），跟 08-14 的 window.scrollBy 同一个对象', () => {
    const f = siteFixture();
    expect(findWheelScroller(mkDoc({ ...f, hit: f.p }), 10, 10, 100)).toBe(f.html);
  });

  it('拿不到命中点（坐标缺失 / 指针落在文档外）时只看视口', () => {
    const f = siteFixture();
    const doc = mkDoc({ ...f, hit: null });
    expect(findWheelScroller(doc, undefined, undefined, 100)).toBe(f.html);
    expect(doc.elementFromPoint).not.toHaveBeenCalled();
    expect(findWheelScroller(mkDoc({ ...f, hit: null }), 10, 10, 100)).toBe(f.html);
  });

  it('滚到底 / 短页：没有目标，滚轮交还画布', () => {
    const bottom = siteFixture({ top: 3000 - 800 });
    expect(findWheelScroller(mkDoc({ ...bottom, hit: bottom.p }), 10, 10, 100)).toBeNull();
    const short = siteFixture({ sh: 800 });
    expect(findWheelScroller(mkDoc({ ...short, hit: short.p }), 10, 10, 100)).toBeNull();
  });

  it('body{overflow:auto} 传播给视口时，滚的是视口，不是 computed 值写着 auto 的 body', () => {
    const html = mkEl('html', { sh: 3000, ch: 800 });
    const body = mkEl('body', { ov: 'auto', sh: 3000, ch: 800 }, html);
    const p = mkEl('p', {}, body);
    expect(findWheelScroller(mkDoc({ html, body, hit: p }), 10, 10, 100)).toBe(html);
  });

  it('html 自己写了 overflow:hidden：视口不可滚', () => {
    const html = mkEl('html', { ov: 'hidden', sh: 3000, ch: 800 });
    const body = mkEl('body', {}, html);
    expect(findWheelScroller(mkDoc({ html, body, hit: body }), 10, 10, 100)).toBeNull();
  });

  it('怪异模式（scrollingElement 是 body）：滚 body，且不往 html 上走', () => {
    const html = mkEl('html', { sh: 800, ch: 800 });
    const body = mkEl('body', { sh: 3000, ch: 800 }, html);
    const p = mkEl('p', {}, body);
    expect(findWheelScroller(mkDoc({ html, body, hit: p, scrollingElement: body }), 10, 10, 100)).toBe(body);
  });

  it('页面里的 overflow:hidden 块不接滚轮（脚本能滚，用户不该滚进去）', () => {
    const f = siteFixture({ top: 3000 - 800 });   // 视口已到底
    const clip = mkEl('clip', { ov: 'hidden', sh: 900, ch: 300 }, f.body);
    const inner = mkEl('inner', {}, clip);
    expect(findWheelScroller(mkDoc({ ...f, hit: inner }), 10, 10, 100)).toBeNull();
  });
});

describe('framePoint / wheelTargetInFrame', () => {
  it('两层缩放一起折回 iframe 文档坐标', () => {
    const frame = {
      offsetWidth: 960, offsetHeight: 540,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 320, height: 180 }),
    };
    expect(framePoint(frame, 260, 110)).toEqual({ x: 480, y: 180 });
  });

  it('还没布局（0 尺寸）/ 没有 frame：null', () => {
    expect(framePoint({ offsetWidth: 960, offsetHeight: 540, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }, 1, 1)).toBeNull();
    expect(framePoint(null, 1, 1)).toBeNull();
  });

  it('同源：按折算后的坐标取命中点，找到里面的容器', () => {
    const f = stageFixture();
    const doc = mkDoc({ ...f, hit: f.para });
    const frame = {
      contentDocument: doc, offsetWidth: 960, offsetHeight: 540,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 270 }),
    };
    expect(wheelTargetInFrame(frame, { clientX: 100, clientY: 50, deltaY: 100 })).toBe(f.beats);
    expect(doc.elementFromPoint).toHaveBeenCalledWith(200, 100);
  });

  it('跨源（contentDocument 为 null 或读取抛错）/ 没挂上：null，不吞事件', () => {
    const rect = () => ({ left: 0, top: 0, width: 10, height: 10 });
    expect(wheelTargetInFrame({ contentDocument: null, getBoundingClientRect: rect }, { deltaY: 100 })).toBeNull();
    const throwing = { getBoundingClientRect: rect };
    Object.defineProperty(throwing, 'contentDocument', { get() { throw new Error('SecurityError'); } });
    expect(wheelTargetInFrame(throwing, { deltaY: 100 })).toBeNull();
    expect(wheelTargetInFrame(null, { deltaY: 100 })).toBeNull();
  });
});

describe('decideCardWheel', () => {
  const T = { tag: 'target' };

  it('Ctrl / ⌘ / Shift 一律放给相机，哪怕里面滚得动', () => {
    for (const k of ['ctrlKey', 'metaKey', 'shiftKey']) {
      expect(decideCardWheel({ [k]: true, deltaY: 100, target: T, now: 0, lastConsumedAt: null })).toBe('pass');
    }
  });

  it('有目标就滚', () => {
    expect(decideCardWheel({ deltaY: 100, target: T, now: 0, lastConsumedAt: null })).toBe('scroll');
  });

  it('⭐ 没目标、也不在锁定窗口里：放行（09-17 以前这里是吞掉）', () => {
    expect(decideCardWheel({ deltaY: 100, target: null, now: 5000, lastConsumedAt: null })).toBe('pass');
    expect(decideCardWheel({ deltaY: 100, target: null, now: 5000, lastConsumedAt: 5000 - WHEEL_LATCH_MS })).toBe('pass');
  });

  it('同一串滚轮刚在卡里滚到头：尾巴吞掉不滚，不溢出去平移画布；纯横向不锁', () => {
    expect(decideCardWheel({ deltaY: 100, target: null, now: 1016, lastConsumedAt: 1000 })).toBe('hold');
    expect(decideCardWheel({ deltaY: 0, target: null, now: 1016, lastConsumedAt: 1000 })).toBe('pass');
  });
});

describe('scrollTargetBy', () => {
  it('有 scrollBy 走 scrollBy（尊重页面的 scroll-behavior，同 08-14）', () => {
    const el = { scrollTop: 0, scrollBy: vi.fn() };
    scrollTargetBy(el, 120);
    expect(el.scrollBy).toHaveBeenCalledWith(0, 120);
  });

  it('没有 scrollBy 时直接加 scrollTop', () => {
    const el = { scrollTop: 30 };
    scrollTargetBy(el, -20);
    expect(el.scrollTop).toBe(10);
  });
});
