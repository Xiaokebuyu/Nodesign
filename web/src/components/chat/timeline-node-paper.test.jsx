// @vitest-environment happy-dom
/**
 * 时间轴节点不许在纸上盖一块自己的底色（2026-08-30 用户报：
 * 「时间轴 icon 的背景色和材质跟我们最新的改动不同，现在有明显区别」）。
 *
 * 病灶：v2 靠在图标底下铺一块不透明方片来「打断」竖线，颜色写死
 * WORKBENCH.panel —— 那是 ThreeColumnLayout 左栏的色，而那个布局早就没人用了；
 * 聊天搬到 ChatDock 那张纸上（PAPER.paper + GRAIN）之后方片就再没跟上：
 *   方片 #FBF7EC 平的 / 纸 #FFFEF9 带颗粒
 * 颗粒一加重，满屏纸纹里就是一个个光滑的小方。
 *
 * 所以这里钉的是**方法**不是颜色：线自己断开，图标那格永远透明。
 * 钉颜色是没用的 —— 纸的颜色会跟着季节皮肤走，追不过来的（追丢过两次）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Clock } from 'lucide-react';
import TimelineNode from './TimelineNode.jsx';
import { TimelinePositionProvider } from './TimelineGroupContext.js';

let host; let root;

function render(position = null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <TimelinePositionProvider value={position}>
        <TimelineNode icon={Clock}>正文</TimelineNode>
      </TimelinePositionProvider>,
    );
  });
  return host;
}

/** 竖线：绝对定位、宽 1px 的那几个 div */
const lines = (el) => [...el.querySelectorAll('div')].filter((d) => d.style.width === '1px');
/** 图标那一格 */
const iconCell = (el) => [...el.querySelectorAll('div')].find((d) => d.querySelector(':scope > svg'));

afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = undefined; });

describe('时间轴节点站在纸上', () => {
  it('⭐ 图标那一格不许有任何底色（纸的颜色/颗粒/季节皮肤都不用追）', () => {
    const cell = iconCell(render());
    expect(cell).toBeTruthy();
    expect(cell.style.background).toBe('');
    expect(cell.style.backgroundColor).toBe('');
    expect(cell.style.backgroundImage).toBe('');
  });

  it('⭐ 线是断开的：上下两截，中间给图标让出一段', () => {
    const el = render();
    const segs = lines(el);
    expect(segs).toHaveLength(2);
    // 图标中心 y = ICON_TOP(GAP.sm 6 + 3) + 7 = 16，上下各让 BREAK=10
    expect(segs[0].style.top).toBe('0px');
    expect(segs[0].style.height).toBe('6px');    // 0 → 16-10
    expect(segs[1].style.top).toBe('26px');      // 16+10 → 底
    expect(segs[1].style.bottom).toBe('0px');
  });

  it('两截线在同一条竖线上（不然断开处会错位）', () => {
    const [up, down] = lines(render());
    expect(up.style.left).toBe(down.style.left);
  });

  it('first 只有下截、last 只有上截、only 一截都没有', () => {
    expect(lines(render('first'))).toHaveLength(1);
    expect(lines(render('first'))[0].style.bottom).toBe('0px');
    act(() => root.unmount()); host.remove();
    expect(lines(render('last'))).toHaveLength(1);
    expect(lines(render('last'))[0].style.top).toBe('0px');
    act(() => root.unmount()); host.remove();
    expect(lines(render('only'))).toHaveLength(0);
  });
});
