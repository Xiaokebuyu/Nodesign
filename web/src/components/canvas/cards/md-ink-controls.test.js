import { describe, it, expect } from 'vitest';
import { parseControls, controlsExpired } from './MdInk.jsx';

/** nd:controls 围栏语法（08-25 控件 = 一系列待发提示词；until = agent 设的有效期） */
describe('parseControls', () => {
  it('标签/文案/箭头提示词/触发件各归各位', () => {
    const { items, until } = parseControls([
      '- [A] 跟上去 -> 选A：跟上去，但保持距离',
      '- [B] 留在原地',
      '- [继续] send',
      '不是控件的行',
    ].join('\n'));
    expect(until).toBeNull();
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({ label: 'A', caption: '跟上去', prompt: '选A：跟上去，但保持距离', trigger: false });
    expect(items[1].prompt).toBe('B 留在原地');
    expect(items[2].trigger).toBe(true);
  });
  it('全角箭头 → 也认；trigger 三种写法；until 指令行', () => {
    const { items, until } = parseControls('until: +30m\n- [标记] 药水已用 → (状态) 背包扣一瓶\n- [发出] trigger\n- [Go] 发送');
    expect(until).toBe('+30m');
    expect(items[0].prompt).toBe('(状态) 背包扣一瓶');
    expect(items[1].trigger).toBe(true);
    expect(items[2].trigger).toBe(true);
  });
});

describe('controlsExpired（有效期判据）', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  it('绝对时刻：过了就死', () => {
    expect(controlsExpired({ until: '2026-08-25T11:00:00Z', now })).toBe(true);
    expect(controlsExpired({ until: '2026-08-25T13:00:00Z', now })).toBe(false);
  });
  it('相对时长：+30m 从板书创建时间起算；没创建时间不敢判死', () => {
    expect(controlsExpired({ until: '+30m', createdAt: '2026-08-25T11:00:00Z', now })).toBe(true);
    expect(controlsExpired({ until: '+2h', createdAt: '2026-08-25T11:00:00Z', now })).toBe(false);
    expect(controlsExpired({ until: '+30m', createdAt: null, now })).toBe(false);
  });
  it('没 until 或写垃圾：永不过期', () => {
    expect(controlsExpired({ until: null, now })).toBe(false);
    expect(controlsExpired({ until: '下周吧', now })).toBe(false);
  });
});
