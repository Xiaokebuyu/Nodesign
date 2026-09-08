// @vitest-environment happy-dom
/**
 * 精灵身体（2026-08-21 按会话模型换身份）。
 * 三件事值得钉住：换 brand 真的换了图形、干活态才有那些动作、潜的节拍器真的会开跑
 * （计时器这种东西"写了"和"跑了"是两回事，这仓库为此立过规矩：重构后要运行时证据）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SpriteFigure, figureWidth } from './sprite-figures.jsx';
import { MARKS, GLM_STROKES } from '../ui/ModelMark.jsx';
import ModelMark from '../ui/ModelMark.jsx';

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<SpriteFigure size={44} {...props} />); });
  return {
    host,
    html: () => host.innerHTML,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('SpriteFigure', () => {
  it('换 brand 换图形：鲸画的是鲸的 path，星芒画的是星芒的', () => {
    const whale = mount({ brand: 'deepseek' });
    expect(whale.html()).toContain(MARKS.deepseek.paths[0].d.slice(0, 40));
    expect(whale.html()).not.toContain(MARKS.claude.paths[0].d.slice(0, 40));
    whale.unmount();

    const star = mount({ brand: 'claude' });
    expect(star.html()).toContain(MARKS.claude.paths[0].d.slice(0, 40));
    star.unmount();
  });

  describe('GLM 三笔顺序提亮（09-08）', () => {
    it('三笔是三个独立形状，各带各的错拍', () => {
      const m = mount({ brand: 'glm', active: true });
      const paths = [...m.host.querySelectorAll('path')].filter(p => p.getAttribute('fill') === MARKS.glm.color);
      expect(paths.length, '墨色形状应该正好三份（三笔）').toBe(3);
      const delays = paths.map(p => p.style.animationDelay);
      expect(new Set(delays).size, `三笔的 delay 得各不相同，现在是 ${delays.join(' / ')}`).toBe(3);
      for (const p of paths) expect(p.style.animation).toContain('ndGlmLit');
      m.unmount();
    });

    it('闲着时不动（全站规矩：闲态只呼吸，这枚连呼吸都不做）', () => {
      const m = mount({ brand: 'glm', active: false });
      expect(m.html()).not.toContain('ndGlmLit');
      m.unmount();
    });

    it('⛔ 墨色形状只画一份 —— 静态一份+动画一份叠着，一动就露双影', () => {
      const m = mount({ brand: 'glm', active: true });
      for (const d of GLM_STROKES) {
        const n = [...m.host.querySelectorAll('path')].filter(p => p.getAttribute('d') === d).length;
        // 一份铅笔稿 + 一份墨 = 2；出现 3 份就是双影
        expect(n, `这一笔画了 ${n} 份（应该是铅笔稿 1 + 墨 1）`).toBe(2);
      }
      m.unmount();
    });

    it('⭐⭐ 这个动画**不许**漏进 picker —— 半透明在那儿的意思是「不可用」', () => {
      // 站主 09-08 划的范围：精灵上动、picker 不动。而且 picker 马上要放
      // 可用性状态色点，一枚会自己变淡的标会跟那颗点抢同一句话。
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => { root.render(<ModelMark brand="glm" size={16} />); });
      expect(host.innerHTML).not.toContain('ndGlmLit');
      expect(host.innerHTML).not.toContain('animation');
      act(() => { root.unmount(); }); host.remove();
    });
  });

  it('认不出的 brand 什么都不画（宁可空着也不画错一家的标）', () => {
    const m = mount({ brand: 'nobody' });
    expect(m.html()).toBe('');
    m.unmount();
  });

  it('闲时鲸只呼吸；干活才加起伏/甩尾/喷气', () => {
    const idle = mount({ brand: 'deepseek', active: false });
    expect(idle.html()).toContain('ndSeaBreath');
    expect(idle.html()).not.toContain('ndSeaBob');
    expect(idle.html()).not.toContain('ndSeaSpout');
    idle.unmount();

    const busy = mount({ brand: 'deepseek', active: true });
    expect(busy.html()).toContain('ndSeaBob');
    expect(busy.html()).toContain('ndSeaTail');
    expect(busy.html()).toContain('ndSeaSpout');
    busy.unmount();
  });

  it('干活起手会潜一次；闲下来立刻不潜（节拍器真的在跑，不是写在那儿好看）', () => {
    vi.useFakeTimers();
    const m = mount({ brand: 'deepseek', active: true });
    expect(m.html()).not.toContain('ndSeaDive');      // 起手先游一会儿
    act(() => { vi.advanceTimersByTime(1200); });
    expect(m.html()).toContain('ndSeaDive');
    act(() => { vi.advanceTimersByTime(3200); });     // 潜完回到常态
    expect(m.html()).not.toContain('ndSeaDive');
    m.unmount();
  });

  it('每个形状只画一份 —— 画两份会成双影：静止时严丝合缝，一动就露出来（08-21 自己踩过）', () => {
    const whale = mount({ brand: 'deepseek', active: true });
    const d = MARKS.deepseek.paths[0].d;
    expect(whale.html().split(d).length - 1).toBe(2);   // 一道铅笔稿 + 一份墨色，仅此
    whale.unmount();

    const oc = mount({ brand: 'opencode', active: true });
    const block = MARKS.opencode.paths[1].d;
    expect(oc.html().split(block).length - 1).toBe(2);
    oc.unmount();
  });

  it('Claude 干活是脉冲星芒：12 根触点 + 中心毂各是一份形状', () => {
    const m = mount({ brand: 'claude', active: true });
    expect(m.html().match(/ndRayPulse/g) || []).toHaveLength(12);
    expect(m.html()).toContain('ndCoreBreath');
    m.unmount();
  });

  it('OpenCode 干活时那截填充块才涨落', () => {
    const idle = mount({ brand: 'opencode', active: false });
    expect(idle.html()).not.toContain('ndOcFill');
    idle.unmount();
    const busy = mount({ brand: 'opencode', active: true });
    expect(busy.html()).toContain('ndOcFill');
    busy.unmount();
  });

  it('figureWidth 按各家外框比例算：鲸最宽、方块最窄、星芒是方的', () => {
    expect(figureWidth('claude', 44)).toBe(44);
    expect(figureWidth('deepseek', 44)).toBeGreaterThan(50);   // 24 : 17.66
    expect(figureWidth('opencode', 44)).toBeLessThan(40);      // 12 : 15
    expect(figureWidth('nobody', 44)).toBe(44);
  });
});
