import { describe, it, expect } from 'vitest';
import { onAgentBrowse, onTurnEnd, onBrowserGone, onUserEngaged } from './browse-window.js';

describe('browse-window 状态转移', () => {
  it('agent 开浏览器 → 弹窗记成 auto，回合结束收掉', () => {
    const win = onAgentBrowse(null, 'https://a.com');
    expect(win).toEqual({ url: 'https://a.com', help: null, auto: true });
    expect(onTurnEnd(win)).toBeNull();
  });

  it('agent 连翻几页仍是 auto', () => {
    const win = onAgentBrowse(onAgentBrowse(null, 'https://a.com'), 'https://a.com/b');
    expect(win).toEqual({ url: 'https://a.com/b', help: null, auto: true });
    expect(onTurnEnd(win)).toBeNull();
  });

  it('人自己开的窗（双击卡片）：agent 翻页只换地址，回合结束不收', () => {
    const mine = { url: 'https://a.com', help: null };
    const win = onAgentBrowse(mine, 'https://b.com');
    expect(win.auto).toBeFalsy();
    expect(win.url).toBe('https://b.com');
    expect(onTurnEnd(win)).toBe(win);
  });

  it('人在 auto 窗里动过 → 归人，不收', () => {
    const win = onUserEngaged(onAgentBrowse(null, 'https://a.com'));
    expect(win.auto).toBe(false);
    expect(onTurnEnd(win)).toBe(win);
    // 之后 agent 再翻页也不会变回 auto
    expect(onAgentBrowse(win, 'https://a.com/c').auto).toBe(false);
  });

  it('求助中的窗不收', () => {
    const win = { url: 'https://a.com', help: '过一下验证', auto: true };
    expect(onTurnEnd(win)).toBe(win);
  });

  it('没有窗 / 人的窗：各转移原样返回', () => {
    expect(onTurnEnd(null)).toBeNull();
    expect(onUserEngaged(null)).toBeNull();
    const mine = { url: null, help: null };
    expect(onUserEngaged(mine)).toBe(mine);
    expect(onBrowserGone(mine)).toBe(mine);
  });

  it('实例被回收：auto 窗一起收', () => {
    expect(onBrowserGone(onAgentBrowse(null, 'https://a.com'))).toBeNull();
  });
});
