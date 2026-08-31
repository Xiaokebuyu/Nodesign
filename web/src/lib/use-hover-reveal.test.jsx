// @vitest-environment happy-dom
/**
 * 「hover 才露出来的钮」在触屏上的契约（2026-08-31）。
 *
 * 用户报「手机上项目卡要点两次才打开」。病根不在 Link 上，在**跟它同一个容器、
 * 靠 hover 才出现的那颗 ⋯** 身上：
 *
 *   手指点一下 → iOS Safari 先补一串合成鼠标事件（mouseover / mouseenter）
 *   → hover 置 true → 那颗钮当场插进 DOM
 *   → ⛔ Safari 看到「这一下让内容变了」，**不再派发 click**
 *   → 第二下内容不变了，click 才发出去
 *
 * ⚠️ **Chromium 复现不了**（它不给触摸补合成鼠标事件，实测 CDP 真触摸一下就进去了），
 * 所以这里不去"模拟 Safari"，而是钉那个能在任何浏览器上判定的**充分条件**：
 * 触屏上一次 mouseover **不许让 DOM 发生任何变化**。DOM 不变，Safari 那条规则
 * 就无从触发。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useHoverReveal } from './use-hover-reveal.js';

const realMM = window.matchMedia;
/** happy-dom 里指针一律 fine，要自己换掉才测得到触屏那一档 */
function fakeMedia(coarse) {
  window.matchMedia = (q) => ({
    matches: q.includes('pointer: coarse') ? coarse : false,
    media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
}
afterEach(() => { window.matchMedia = realMM; });

/** 一个最小的复刻：容器 + 链接 + 那颗露出式的钮 */
function Card() {
  const { revealed, hover, hoverProps } = useHoverReveal();
  return (
    <div data-card {...hoverProps} data-lifted={hover ? '1' : '0'}>
      <a href="/somewhere">打开</a>
      {revealed && <button data-more>⋯</button>}
    </div>
  );
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<Card />); });
  return {
    host,
    card: () => host.querySelector('[data-card]'),
    more: () => host.querySelector('[data-more]'),
    lifted: () => host.querySelector('[data-card]')?.getAttribute('data-lifted'),
    html: () => host.innerHTML,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

describe('触屏：那颗钮常驻，且鼠标事件一个都不挂', () => {
  beforeEach(() => fakeMedia(true));

  it('⭐ 一上来就画出来了 —— 不用先"悬"一下（触屏根本没有悬）', () => {
    const m = mount();
    expect(m.more(), '触屏上 ⋯ 应该常驻').toBeTruthy();
    m.unmount();
  });

  it('⛔⛔ 一次 mouseover 之后 DOM 必须逐字节不变（这就是 Safari 吞掉 click 的判据）', () => {
    const m = mount();
    const before = m.html();
    act(() => {
      m.card().dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      m.card().dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
    });
    expect(m.html(), 'mouseover 改了 DOM —— iOS 上这一下的 click 会被吞掉，用户要点两次').toBe(before);
    m.unmount();
  });

  it('视觉抬起不许在触屏上恒亮（hover 和 revealed 是两个问题）', () => {
    const m = mount();
    expect(m.lifted(), '触屏上不该有"悬着"这个状态').toBe('0');
    m.unmount();
  });
});

describe('鼠标：照旧是悬上去才露出来', () => {
  beforeEach(() => fakeMedia(false));

  it('一开始没有，mouseenter 之后才有，mouseleave 之后又没了', () => {
    const m = mount();
    expect(m.more()).toBeFalsy();
    act(() => { m.card().dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); });
    expect(m.more(), '鼠标悬上去要露出来').toBeTruthy();
    expect(m.lifted()).toBe('1');
    act(() => { m.card().dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    expect(m.more(), '鼠标移开要收回去').toBeFalsy();
    m.unmount();
  });
});

/**
 * 这个写法在仓里被抄了五处，⛔ 只修一处等于留四个复发点。
 * 判据钉形状：`onMouseEnter={() => setHover(` 这个手抄的样子一处都不许再有。
 */
describe('全仓不许再手抄这个写法', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.jsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [p] : [];
  });

  it('⛔ 一处 onMouseEnter={() => setHover( 都不许剩，全部走 useHoverReveal', () => {
    const bad = walk(SRC).filter(f => /onMouseEnter=\{\(\) => setHover\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f));
    expect(bad, `这几处还在手抄：${bad.join(', ')}`).toEqual([]);
  });

  it('五个已知调用点都还接着这个 hook（谁被改回去了立刻看得见）', () => {
    const SITES = [
      'routes/Home.jsx', 'routes/Showcase.jsx',
      'components/project/SessionListModal.jsx', 'components/project/FilesCard.jsx',
      // ⭐ 这两处是**判据自己抓出来的**，我先前拿 `{hover &&` grep 全仓漏掉了它们 ——
      //   它们写的是 `{onRemove && hover &&` / `{canUndo && hover &&`。
      'components/canvas/CanvasCandidateBar.jsx', 'components/chat/UserMessage.jsx',
    ];
    for (const f of SITES) {
      expect(fs.readFileSync(path.join(SRC, f), 'utf8'), `${f} 不再用 useHoverReveal`)
        .toMatch(/useHoverReveal\(/);
    }
    // 首页有两处（最近对话行 + 项目卡）
    const home = fs.readFileSync(path.join(SRC, 'routes/Home.jsx'), 'utf8');
    expect((home.match(/useHoverReveal\(/g) || []).length).toBe(2);
  });
});
