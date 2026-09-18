// 文件夹归堆（09-18）：按时间按本地日历日分、按类型按认得的名字分，组内最近在前；件数少不叠。
import { describe, it, expect } from 'vitest';
import { stackGroups, autoAxis, timeBucketOf, latestFirst, sameKindOf, STACK_MIN } from './folder-stacks.js';

// 「现在」取本地时间下午三点，边界都按本地零点算，跟机器时区无关
const now = new Date(2026, 8, 18, 15, 0, 0).getTime();
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const img = (id, mtime) => ({ id, type: 'image', mtime });

describe('timeBucketOf', () => {
  it('今天 / 昨天 / 前 7 天 / 前 30 天 / 按月，按本地零点切', () => {
    expect(timeBucketOf(at(2026, 9, 18, 0), now).label).toBe('今天');
    expect(timeBucketOf(at(2026, 9, 17, 23), now).label).toBe('昨天');
    expect(timeBucketOf(at(2026, 9, 12), now).label).toBe('前 7 天');
    expect(timeBucketOf(at(2026, 8, 25), now).label).toBe('前 30 天');
    expect(timeBucketOf(at(2026, 7, 1), now).label).toBe('2026 年 7 月');
    expect(timeBucketOf(undefined, now).label).toBe('更早');
  });
});

describe('stackGroups', () => {
  it('⭐ 按时间：新的堆在前，堆里最近的在前', () => {
    const items = [img('a', at(2026, 9, 12)), img('b', at(2026, 9, 18, 9)), img('c', at(2026, 9, 18, 14)), img('d', at(2026, 9, 17))];
    const g = stackGroups(items, 'time', now);
    expect(g.map((x) => x.label)).toEqual(['今天', '昨天', '前 7 天']);
    expect(g[0].items.map((x) => x.id)).toEqual(['c', 'b']);
  });

  it('按类型：按认得的名字分，顺序固定（图片在站点前）', () => {
    const items = [{ id: 's', type: 'site' }, img('i', at(2026, 9, 1)), { id: 'n', type: 'note' }, { id: 'x', type: 'weird' }];
    expect(stackGroups(items, 'type', now).map((x) => x.label)).toEqual(['图片', '站点', '便签', '其他']);
  });

  it('不叠返回 null', () => {
    expect(stackGroups([img('a')], 'none', now)).toBeNull();
  });
});

describe('autoAxis', () => {
  it(`件数不过 ${STACK_MIN} 不叠；清一色按时间；混着几类按类型`, () => {
    const many = Array.from({ length: STACK_MIN + 1 }, (_, i) => img(`i${i}`));
    expect(autoAxis(many.slice(0, STACK_MIN))).toBe('none');
    expect(autoAxis(many)).toBe('time');
    expect(autoAxis([...many, { id: 's', type: 'site' }])).toBe('type');
  });
});

describe('latestFirst', () => {
  it('没有时间的垫底', () => {
    expect(latestFirst([img('a'), img('b', at(2026, 9, 1)), img('c', at(2026, 9, 2))]).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('sameKindOf（同类收卡）', () => {
  const site = (id, mtime) => ({ id: `site:${id}`, type: 'site', mtime });
  it('⭐ 两件以上、清一色的站点 / 演示 / 文档才收；最近的排第一', () => {
    const r = sameKindOf([site('a', at(2026, 9, 1)), site('b', at(2026, 9, 3))]);
    expect(r.kind).toBe('site');
    expect(r.members.map((m) => m.id)).toEqual(['site:b', 'site:a']);
  });
  it('不收：只有一件、混了别的、有子文件夹、全是图', () => {
    expect(sameKindOf([site('a')])).toBeNull();
    expect(sameKindOf([site('a'), { id: 'x.md', type: 'note' }])).toBeNull();
    expect(sameKindOf([site('a'), site('b')], 1)).toBeNull();
    expect(sameKindOf([img('a'), img('b')])).toBeNull();
  });
});
