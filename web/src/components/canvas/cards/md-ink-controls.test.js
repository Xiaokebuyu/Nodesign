import { describe, it, expect } from 'vitest';
import { parseControls } from './MdInk.jsx';

/** nd:controls 围栏语法（08-25 控件 = 一系列待发提示词） */
describe('parseControls', () => {
  it('标签/文案/箭头提示词/触发件各归各位', () => {
    const items = parseControls([
      '- [A] 跟上去 -> 选A：跟上去，但保持距离',
      '- [B] 留在原地',
      '- [继续] send',
      '不是控件的行',
    ].join('\n'));
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({ label: 'A', caption: '跟上去', prompt: '选A：跟上去，但保持距离', trigger: false });
    expect(items[1].prompt).toBe('B 留在原地');
    expect(items[2].trigger).toBe(true);
  });
  it('全角箭头 → 也认；trigger 三种写法', () => {
    const items = parseControls('- [标记] 药水已用 → (状态) 背包扣一瓶\n- [发出] trigger\n- [Go] 发送');
    expect(items[0].prompt).toBe('(状态) 背包扣一瓶');
    expect(items[1].trigger).toBe(true);
    expect(items[2].trigger).toBe(true);
  });
});
