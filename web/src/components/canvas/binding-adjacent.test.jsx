// @vitest-environment happy-dom
/**
 * 贴着的两件不画线（2026-08-31 站主提「距离过近的两个板书或者产物也许不需要连线」）。
 *
 * 实测 proj_mth8wd7k：42 条线**全部端点可见**，两端矩形最短间距 ≤24px 的有 19 条
 * （45%），其中 16 条整整齐齐是 20px —— 全是「选项板 annotates 本拍正文」，两张卡
 * 并排贴着中间还画一根 20px 的短线。
 *
 * 这一组钉两头：贴着的平时不画（连命中区都不留），悬停端点照常亮出来（信息没丢）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import BindingLayer from './BindingLayer.jsx';

let host; let root;
const render = (props) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<BindingLayer width={2000} height={2000} {...props} />); });
};
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

/**
 * ⚠️ 只数**画出来的线**：`<defs>` 里每种线型都常驻一对箭头 marker（也是 path），
 * 不管有没有线在画都在那儿 —— 第一版选择器把它们数进来了，断言当场是假的。
 * 这是「测试选择器选到外层/邻居」那条老坑的第三例，判据要贴着被断言的东西。
 */
const linePaths = () => [...host.querySelectorAll('svg > g path')];
const realPaths = () => linePaths().filter(p => {
  const st = p.getAttribute('stroke');
  return st && st !== 'transparent' && !st.startsWith('rgba(43,33,23');
}).length;
const hitPaths = () => linePaths().filter(p => p.getAttribute('stroke') === 'transparent').length;

const RECTS = {
  正文: { x: 0, y: 0, w: 432, h: 300 },
  贴右: { x: 452, y: 0, w: 300, h: 200 },        // 间距 20px（真板上那 16 条的形状）
  远处: { x: 1200, y: 0, w: 300, h: 200 },       // 间距 768px
};
const rectOf = (id) => RECTS[id] || null;

describe('贴着不画线', () => {
  it('⛔ 间距 20px 的一条：整条不出现，连透明命中区都不留', () => {
    render({ bindings: { b1: { type: 'annotates', from: '贴右', to: '正文' } }, rectOf });
    expect(realPaths()).toBe(0);
    expect(hitPaths(), '命中区留着 = 在两张卡缝里埋一条抢指针的隐形粗线').toBe(0);
  });

  it('间距远的照画', () => {
    render({ bindings: { b1: { type: 'flow', from: '正文', to: '远处' } }, rectOf });
    expect(realPaths()).toBeGreaterThan(0);
  });

  it('⭐ 悬停端点时贴着的那条亮出来 —— 信息没丢，只是平时不占眼睛', () => {
    render({ bindings: { b1: { type: 'annotates', from: '贴右', to: '正文' } }, rectOf, hotEndpointId: '正文' });
    expect(realPaths()).toBeGreaterThan(0);
  });

  it('悬停线本身也亮（hoveredId）', () => {
    render({ bindings: { b1: { type: 'annotates', from: '贴右', to: '正文' } }, rectOf, hoveredId: 'b1' });
    expect(realPaths()).toBeGreaterThan(0);
  });

  it('一块板上混着：只剩远的那条', () => {
    render({
      bindings: {
        near: { type: 'annotates', from: '贴右', to: '正文' },
        far: { type: 'flow', from: '正文', to: '远处' },
      },
      rectOf,
    });
    expect(hitPaths(), '两条线只剩一条有命中区').toBe(1);
  });
});
