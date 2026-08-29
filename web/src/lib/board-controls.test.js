import { describe, it, expect } from 'vitest';
import { controlsMetaOf, staleControlIds } from './board-controls.js';

const fence = (body) => '标题\n\n```nd:controls\n' + body + '\n```\n尾巴';

describe('控件生命周期（08-25：默认常设，supersede 显式声明）', () => {
  it('controlsMetaOf：抽 supersede，没有围栏返回 null', () => {
    expect(controlsMetaOf(fence('supersede: 章节选项\n- [A] x -> y'))).toEqual({ supersede: '章节选项' });
    expect(controlsMetaOf(fence('- [A] x -> y'))).toEqual({ supersede: null });
    expect(controlsMetaOf('没有围栏的板书')).toBeNull();
  });

  it('同组新的顶掉旧的；不同组互不干涉；没声明的永不失效', () => {
    const chalks = [
      { id: 'notes/板书/20260825-1000-第一章选项.md', text: fence('supersede: 章节选项\n- [A] a') },
      { id: 'notes/板书/20260825-1100-第二章选项.md', text: fence('supersede: 章节选项\n- [A] a') },
      { id: 'notes/板书/20260825-1030-背包.md', text: fence('- [用药水] -> 用一瓶治疗药水') },
      { id: 'notes/板书/20260825-1040-商店.md', text: fence('supersede: 商店\n- [买剑] -> 买长剑') },
    ];
    const stale = staleControlIds(chalks);
    expect(stale.has('notes/板书/20260825-1000-第一章选项.md')).toBe(true);   // 被第二章顶掉
    expect(stale.has('notes/板书/20260825-1100-第二章选项.md')).toBe(false);
    expect(stale.has('notes/板书/20260825-1030-背包.md')).toBe(false);        // 常设：永不误杀
    expect(stale.has('notes/板书/20260825-1040-商店.md')).toBe(false);        // 组里只有自己
  });
});
