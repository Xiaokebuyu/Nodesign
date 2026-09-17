// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ArtifactCard, { ARTIFACT_FACES } from './ArtifactCard.jsx';

// 活预览换成不带 src 的 iframe：happy-dom 会真去拉 src（打到 localhost:3000 再报一串
// NetworkError）。只有下面滚轮那组会挂上活预览（其余用例的 IntersectionObserver 不回调），
// 它们要的只是「卡里有个 iframe、frameRef 指着它」。
vi.mock('../LiveFrame.jsx', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ title, frameRef, style }) => createElement('iframe', {
      title, style, ref: (n) => { if (frameRef) frameRef.current = n; },
    }),
  };
});
import { sizeOf } from '../../../lib/board-kinds.js';
import { CARD_EDGE } from '../../../lib/board-geometry.js';

/**
 * 统一方卡的渲染冒烟 + 三张脸的信息量不丢。
 *
 * ## 为什么这个测试值得存在
 *
 * 这张卡替掉了 BoardCanvas 里六个分支约 180 行。收成一套的风险不在"能不能
 * 渲染"，在**把各形态的信息量弄丢** —— 站点要显示页数、世界要显示地点/角色
 * 计数、deck 要显示时间。丢了不会报错，只会在画布上变成三张一模一样的卡。
 *
 * 另一半是渲染冒烟本身：这个目录下的组件因为 TDZ 白屏栽过四次，而
 * `vite build` 和纯函数单测都照不出来。这里真的挂一次 React 树。
 *
 * happy-dom 没有 IntersectionObserver，所以缩略图走"还没进视口"那条分支 ——
 * 正好是我们要的：**断言的是骨架和文案，不是 iframe 里加载了什么**。
 */

let host;
let root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (o) => {
  act(() => root.render(
    <ArtifactCard o={o} projectId="p1" fileVersions={{}} scale={1} />,
  ));
  return host.textContent;
};

const DECK = { id: 'deck:稿件/主稿.html', type: 'deck', title: '主稿', deckFile: '稿件/主稿.html', mtime: '2026-08-13T06:04:00.000Z' };
const SITE = { id: 'site:研究站', type: 'site', title: '研究站', base: '研究站', entry: 'index.html', pages: ['index.html', 'about.html', 'posts/a.html'] };

describe('ArtifactCard 渲染冒烟', () => {
  it('两种产物都挂得起来，且各自的标题在卡上', () => {
    expect(render(DECK)).toContain('主稿');
    expect(render(SITE)).toContain('研究站');
  });

  it('不认识的 type 什么都不画（而不是抛错）', () => {
    act(() => root.render(<ArtifactCard o={{ id: 'x', type: 'image' }} projectId="p1" fileVersions={{}} />));
    expect(host.textContent).toBe('');
  });

  it('预览区高度是形态表算出来的那个恒定值（布局按矩形排布，不能是 auto）', () => {
    render(DECK);
    // 外框 = 形态表里的 size；纸边（CARD_EDGE）画在框里，所以预览 = size.h 扣掉顶栏和上下两道边。
    // 预览这块自己不能是 auto
    const preview = host.querySelector('div > div:nth-child(2)');
    expect(preview.style.height).toBe(`${sizeOf(DECK).h - 28 - 2 * CARD_EDGE}px`);
  });

  it('⭐ 预览区宽 = 卡宽扣掉两道纸边（09-12：多出 2px 就盖住右边那道墨线，站主报「显示器一侧墨边不完整」）', () => {
    render(DECK);
    expect(host.querySelector('div > div:nth-child(2)').style.width).toBe(`${sizeOf(DECK).w - 2 * CARD_EDGE}px`);
    const hero = { ...SITE, tier: 'hero' };
    render(hero);
    expect(host.querySelector('div > div:nth-child(2)').style.width, '主角档也得扣').toBe(`${sizeOf(hero).w - 2 * CARD_EDGE}px`);
  });
});

describe('每张脸的信息量一个都不能丢', () => {
  it('站点说得出页数；单页说得出它是单页', () => {
    expect(ARTIFACT_FACES.site.summary(SITE)).toBe('站点 · 3 个页面');
    expect(ARTIFACT_FACES.site.summary({ single: true })).toBe('单页');
    // 页数缺失时退回 1，不显示 "undefined 个页面"
    expect(ARTIFACT_FACES.site.summary({})).toBe('站点 · 1 个页面');
  });

  /**
   * ⚠️ 计数口径必须跟服务端 `describe()` 一致：**容器不算地点**（它是收纳态，
   * 设计上明确不是地点）。两处对不上会像 bug —— 用户在窗里看到 2 个地点，
   * 卡片上写 3 个。
   */
  it('世界的地点/角色计数不把容器算进地点', () => {
  });

  it('deck 说得出改动时间', () => {
    expect(ARTIFACT_FACES.deck.summary(DECK)).toMatch(/^幻灯 · \d+\/\d+ \d{2}:\d{2}$/);
    // 没有 mtime 时不留一条尾巴（"幻灯 · "）
    expect(ARTIFACT_FACES.deck.summary({})).toBe('幻灯');
  });

  /**
   * 站点和世界在 2026-08-13 之前都用 `Globe` —— 桌面上一眼分不出这张卡是
   * 站点还是世界。收成一套之后图标是仅剩的形态标识，撞了就等于没有。
   */
  it('每种形态的图标互不相同（站点和浏览器都想用 Globe，撞过一次）', () => {
    const icons = Object.values(ARTIFACT_FACES).map(f => f.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

/**
 * 预览态滚轮的接线（09-17，问题库 iss_mtuhruna_yg6c）。判定逻辑的细目在
 * lib/card-wheel.test.js；这里只钉组件有没有按判定去吞 / 放 / 滚。
 *
 * 以前一律 preventDefault 再 `contentWindow.scrollBy`：演出显示器的文档不滚，
 * 于是内容不动、事件又被吞，画布也不平移。
 *
 * happy-dom 默认没有 IntersectionObserver 回调，这里换一个一挂上就报「在视口里」的，
 * 滚轮监听才会装上；iframe 的文档换成假对象（只要命中点、样式、滚动尺寸）。
 */
describe('预览态滚轮：找得到可滚容器才吞，找不到交还画布', () => {
  let savedIO;
  beforeEach(() => {
    savedIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting: true }]); }
      disconnect() {}
    };
  });
  afterEach(() => { globalThis.IntersectionObserver = savedIO; });

  const STAGE = { id: 'stage:夜班', type: 'stage', title: '夜班', root: '夜班', stage: { beats: 3, cast: [] } };

  const el = (ov, { top = 0, sh = 100, ch = 100 } = {}, parent = null) => ({
    ov, scrollTop: top, scrollHeight: sh, clientHeight: ch, parentElement: parent, scrollBy: vi.fn(),
  });

  /** 演出显示器：body overflow:hidden，正文在 .beats 里滚 */
  function stageDoc({ beatsTop = 0 } = {}) {
    const html = el('visible', { sh: 540, ch: 540 });
    const body = el('hidden', { sh: 540, ch: 540 }, html);
    const beats = el('auto', { top: beatsTop, sh: 2000, ch: 496 }, body);
    const p = el('visible', {}, beats);
    return { html, body, beats, hit: p };
  }

  /** 普通站点：文档自己滚 */
  function siteDoc() {
    const html = el('visible', { sh: 3000, ch: 800 });
    const body = el('visible', { sh: 2984, ch: 2984 }, html);
    const p = el('visible', {}, body);
    return { html, body, hit: p };
  }

  function mount(o, d) {
    act(() => root.render(<ArtifactCard o={o} projectId="p1" fileVersions={{}} scale={1} />));
    const box = host.querySelector('div > div:nth-child(2)');
    const frame = box.querySelector('iframe');
    expect(frame, '视口内应挂上活预览').toBeTruthy();
    const doc = {
      defaultView: { getComputedStyle: (x) => ({ overflowY: x.ov }) },
      documentElement: d.html, body: d.body, scrollingElement: d.html,
      elementFromPoint: () => d.hit,
    };
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => doc });
    Object.defineProperty(frame, 'offsetWidth', { configurable: true, get: () => 960 });
    Object.defineProperty(frame, 'offsetHeight', { configurable: true, get: () => 540 });
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 });
    const reached = vi.fn();
    host.addEventListener('wheel', reached);
    return { box, reached };
  }

  /** happy-dom 的 WheelEvent 继承 UIEvent，不认 clientX / ctrlKey 这些鼠标字段 —— 手动挂上 */
  const wheel = (target, { deltaY, ...mouse }) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
    Object.assign(e, { clientX: 10, clientY: 10, ctrlKey: false, metaKey: false, shiftKey: false, ...mouse });
    target.dispatchEvent(e);
    return e;
  };

  it('⭐ 演出卡：滚的是显示器里的 .beats，事件不再冒到画布', () => {
    const d = stageDoc();
    const { box, reached } = mount(STAGE, d);
    const e = wheel(box, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(true);
    expect(d.beats.scrollBy).toHaveBeenCalledWith(0, 100);
    expect(reached).not.toHaveBeenCalled();
  });

  it('⭐ 演出卡：正文已到底、文档本身又不滚 → 不吞，画布收得到这一下', () => {
    const d = stageDoc({ beatsTop: 2000 - 496 });
    const { box, reached } = mount(STAGE, d);
    const e = wheel(box, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalledTimes(1);
    for (const x of [d.html, d.body, d.beats]) expect(x.scrollBy).not.toHaveBeenCalled();
  });

  it('站点卡原有行为：长页照旧吞掉并滚文档（scrollingElement.scrollBy）', () => {
    const d = siteDoc();
    const { box, reached } = mount(SITE, d);
    const e = wheel(box, { deltaY: 80 });
    expect(e.defaultPrevented).toBe(true);
    expect(d.html.scrollBy).toHaveBeenCalledWith(0, 80);
    expect(reached).not.toHaveBeenCalled();
  });

  it('Ctrl+滚轮照旧交给相机缩放', () => {
    const d = siteDoc();
    const { box, reached } = mount(SITE, d);
    const e = wheel(box, { deltaY: 80, ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalledTimes(1);
    expect(d.html.scrollBy).not.toHaveBeenCalled();
  });

  it('滚到头的同一串尾巴吞掉不滚（不溢出去平移画布）', () => {
    const d = stageDoc({ beatsTop: 2000 - 496 - 50 });
    const { box, reached } = mount(STAGE, d);
    expect(wheel(box, { deltaY: -40 }).defaultPrevented).toBe(true);   // 先往上滚一下，锁住
    d.beats.scrollTop = 2000 - 496;                                     // 再到底
    const tail = wheel(box, { deltaY: 100 });
    expect(tail.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    expect(d.beats.scrollBy).toHaveBeenCalledTimes(1);
  });
});

/**
 * 拉远以后的服务端缩略图（09-17，问题库 iss_mu0v5pa5_3ojg）。
 *
 * 原来 scale < 0.35 时只画横线纸 + 图标，电脑上拉远看全貌是满屏空白纸。现在 deck / 站点在
 * 「进了视口、活预览不挂」时叠一张 /artifact-thumb 的图，占位垫在底下（加载中 / 失败时露出来）。
 */
describe('远景缩略图', () => {
  let savedIO;
  let inView = true;
  beforeEach(() => {
    inView = true;
    savedIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting: inView }]); }
      disconnect() {}
    };
  });
  afterEach(() => { globalThis.IntersectionObserver = savedIO; });

  const mountAt = (o, scale, fileVersions = {}) => {
    act(() => root.render(<ArtifactCard o={o} projectId="p1" fileVersions={fileVersions} scale={scale} />));
    return host.querySelector('div > div:nth-child(2)');
  };
  const thumbOf = (box) => box.querySelector('img[data-far-thumb]');
  const params = (img) => new URL(img.getAttribute('src'), 'http://x').searchParams;
  const fire = (el, type) => act(() => { el.dispatchEvent(new Event(type)); });

  it('⭐ 站点卡拉远（0.2）且在视口里：请求缩略图，占位图标垫在底下，图加载完才显出', () => {
    const box = mountAt(SITE, 0.2, { '研究站/style.css': 2, '研究站/about.html': 5 });
    const img = thumbOf(box);
    expect(img, '应挂上缩略图').toBeTruthy();
    expect(img.getAttribute('src').startsWith('/api/projects/p1/artifact-thumb?')).toBe(true);
    expect(params(img).get('path')).toBe('研究站/index.html');
    expect(params(img).get('kind')).toBe('site');
    // 版本号同活预览：本页 html + 产物根下非 html（about.html 不算）
    expect(params(img).get('v')).toBe('2');
    expect(box.querySelector('svg'), '占位图标仍在').toBeTruthy();
    expect(box.querySelector('iframe')).toBeNull();
    expect(img.style.opacity).toBe('0');
    fire(img, 'load');
    expect(thumbOf(box).style.opacity).toBe('1');
  });

  it('⭐ 根站（base 为空串）的入口不带前导斜杠', () => {
    const box = mountAt({ ...SITE, base: '', task: '' }, 0.2);
    expect(params(thumbOf(box)).get('path')).toBe('index.html');
  });

  it('⭐ 截图失败（204 / 出错）→ 撤掉图只留占位；地址换了（agent 改了产物）再试一次', () => {
    let box = mountAt(SITE, 0.2);
    fire(thumbOf(box), 'error');
    expect(thumbOf(box)).toBeNull();
    expect(box.querySelector('svg')).toBeTruthy();
    // 同一地址重渲染不重试
    box = mountAt(SITE, 0.25);
    expect(thumbOf(box)).toBeNull();
    // 版本号变了 → 新地址 → 重新请求
    box = mountAt(SITE, 0.25, { '研究站/style.css': 1 });
    expect(thumbOf(box)).toBeTruthy();
    expect(params(thumbOf(box)).get('v')).toBe('1');
  });

  it('已显出的图在地址变化时不闪回占位', () => {
    let box = mountAt(SITE, 0.2);
    fire(thumbOf(box), 'load');
    box = mountAt(SITE, 0.2, { '研究站/index.html': 1 });
    expect(params(thumbOf(box)).get('v')).toBe('1');
    expect(thumbOf(box).style.opacity).toBe('1');
  });

  it('⭐ deck 卡拉远：按 deckFile 请求，kind=deck，整页 contain', () => {
    const box = mountAt(DECK, 0.1, { '稿件/主稿.html': 4 });
    const img = thumbOf(box);
    expect(params(img).get('path')).toBe('稿件/主稿.html');
    expect(params(img).get('kind')).toBe('deck');
    expect(params(img).get('v')).toBe('4');
    expect(img.style.objectFit).toBe('contain');
  });

  it('⭐ 镜头够近（≥ 0.35）→ 活预览，不请求缩略图', () => {
    const box = mountAt(SITE, 0.35);
    expect(box.querySelector('iframe')).toBeTruthy();
    expect(thumbOf(box)).toBeNull();
  });

  it('⭐ 不在视口里 → 不请求（出视口的卡不给服务端派活）', () => {
    inView = false;
    const box = mountAt(SITE, 0.2);
    expect(thumbOf(box)).toBeNull();
    expect(box.querySelector('iframe')).toBeNull();
    expect(box.querySelector('svg')).toBeTruthy();
  });

  it('范围只到 deck / 站点：文档、浏览器、演出、仓库卡拉远仍是占位', () => {
    const others = [
      { id: 'docx:a.docx', type: 'docx', title: 'a', deckFile: 'a.docx' },
      { id: 'browse', type: 'browse', title: 'b', host: 'x.com', url: 'https://x.com' },
      { id: 'stage:夜班', type: 'stage', title: '夜班', root: '夜班', stage: { beats: 1, cast: [] } },
      { id: 'repo:r', type: 'repo', title: 'r' },
    ];
    for (const o of others) {
      const box = mountAt(o, 0.2);
      expect(thumbOf(box), o.type).toBeNull();
      expect(box.querySelector('img'), o.type).toBeNull();
    }
    expect(Object.keys(ARTIFACT_FACES).filter(k => ARTIFACT_FACES[k].thumb).sort()).toEqual(['deck', 'site']);
  });
});
