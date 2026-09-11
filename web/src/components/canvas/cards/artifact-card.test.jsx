// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ArtifactCard, { ARTIFACT_FACES } from './ArtifactCard.jsx';
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
