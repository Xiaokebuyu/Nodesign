// 话题的地盘与整组让开（09-18）：每条都给一个必须让开的东西，再配一个不该动的。
import { describe, it, expect } from 'vitest';
import { settleTopics, topicKeys, topicObstacles, regionOf, TOPIC_PAD } from './topic-settle.js';

const r = (id, x, y, w = 200, h = 100, extra = {}) => ({ id, x, y, w, h, ...extra });

describe('topicKeys', () => {
  it('同 tag 一个话题；没 tag 自成一个；圈注和用户蓝字归它圈 / 标的那件', () => {
    const k = topicKeys([r('a', 0, 0, 1, 1, { tag: '配色' }), r('b', 0, 0, 1, 1), r('hug1', 0, 0, 1, 1, { hug: 'a' }), r('text:u', 0, 0, 1, 1, { note: 'b' })]);
    expect(k.get('a')).toBe('#配色');
    expect(k.get('b')).toBe('@b');
    expect(k.get('hug1')).toBe('#配色');
    expect(k.get('text:u')).toBe('@b');
  });
});

describe('settleTopics', () => {
  it('⭐ 话题长高撞上别的话题：对方整组朝位移最小的方向让开，自己不动', () => {
    // A 组两张竖排，第一张长高到压进 B 组的地盘；B 组两件在 A 的正下方
    // a1 原来 100 高、a2 贴在它下面；B 组在 A 的地盘外面一点点。a1 长到 500
    const items = [
      r('a1', 0, 0, 200, 500, { tag: 'A' }), r('a2', 0, 120, 200, 100, { tag: 'A' }),
      r('b1', 0, 260, 200, 100, { tag: 'B' }), r('b2', 220, 260, 200, 100, { tag: 'B' }),
    ];
    const out = settleTopics(items, ['a1'], { grewFrom: { a1: 100 } });
    const m = Object.fromEntries(out.moves.map((x) => [x.id, x]));
    expect(m.a2.dy).toBe(396);                       // 同组往下推：新底 500 + 16 − 原位 120
    expect([m.b1.dx, m.b1.dy]).toEqual([m.b2.dx, m.b2.dy]);   // B 整组一起
    // 四个方向里位移最小的是往右 224（往下要 380）：不限横竖，取最省的那个
    expect([m.b1.dx, m.b1.dy]).toEqual([224, 0]);
    expect(m.a1).toBeUndefined();                    // 长大的那个不动
    const ra = regionOf([items[0], { ...items[1], y: 120 + 396 }]);
    const rb = regionOf([{ ...items[2], x: m.b1.dx, y: 260 }, { ...items[3], x: 220 + m.b2.dx, y: 260 }]);
    expect(ra.x + ra.w).toBeLessThanOrEqual(rb.x);   // 地盘不再相交
    expect(out.pushed).toEqual(['#B']);
  });

  it('不限横竖：撞在右边就往右让', () => {
    const items = [r('a', 0, 0, 300, 100, { tag: 'A' }), r('b', 310, 0, 200, 100, { tag: 'B' })];
    const out = settleTopics(items, ['a']);
    expect(out.moves.map((x) => [x.id, x.dx, x.dy])).toEqual([['b', 300 + TOPIC_PAD * 2 - 310, 0]]);
  });

  it('连锁：被推开的再撞到别人接着传', () => {
    const items = [r('a', 0, 0, 300, 100, { tag: 'A' }), r('b', 320, 0, 200, 100, { tag: 'B' }), r('c', 540, 0, 200, 100)];
    const out = settleTopics(items, ['a']);
    expect(out.pushed.sort()).toEqual(['#B', '@c']);
  });

  it('不撞就不动；地盘之间留出两个外扩的空隙才算不撞', () => {
    expect(settleTopics([r('a', 0, 0, 200, 100, { tag: 'A' }), r('b', 200 + TOPIC_PAD * 2, 0)], ['a']).moves).toEqual([]);
  });

  it('推不动的只报：文件夹卡、卷卡、标了 fixed 的', () => {
    const out = settleTopics([r('a', 0, 0, 300, 100, { tag: 'A' }), r('稿', 310, 0, 288, 240, { folder: true }), r('roll:x', 0, 120, 100, 40)], ['a']);
    expect(out.moves).toEqual([]);
    expect(out.blocked.sort()).toEqual(['@roll:x', '@稿']);
  });

  it('圈注跟着被圈的那件一起让，不被当成别人推开', () => {
    const items = [r('a', 0, 0, 300, 100, { tag: 'A' }), r('b', 310, 0, 200, 100, { tag: 'B' }), r('s', 300, -10, 230, 120, { hug: 'b' })];
    const m = Object.fromEntries(settleTopics(items, ['a']).moves.map((x) => [x.id, x]));
    expect(m.s.dx).toBe(m.b.dx);
  });
});

describe('topicObstacles', () => {
  it('别的话题整块地盘当一个障碍，自己话题逐件', () => {
    const rects = [r('a1', 0, 0, 100, 100, { tag: 'A' }), r('a2', 200, 0, 100, 100, { tag: 'A' }), r('b1', 0, 300, 100, 100, { tag: 'B' }), r('b2', 400, 300, 100, 100, { tag: 'B' }), r('c', 900, 0)];
    const out = topicObstacles(rects, 'A');
    expect(out.map((o) => o.id).sort()).toEqual(['a1', 'a2', 'c', 'topic:B']);
    expect(out.find((o) => o.id === 'topic:B')).toMatchObject({ x: -TOPIC_PAD, w: 500 + TOPIC_PAD * 2 });
  });
});
