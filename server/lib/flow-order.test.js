import { describe, it, expect } from 'vitest';
import { flowOrder } from './flow-order.js';

const items = (...ids) => ids.map((id) => ({ id }));
const ids = (r) => r.order.map((m) => m.id);

describe('flowOrder —— 线上的按线排，线外的留在原名次', () => {
  it('09-11 案：两列被按行读成 n1 n4 n2 n5 n3，线是 n1→…→n5 → 排回线的顺序', () => {
    const flows = [['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5']].map(([from, to]) => ({ from, to }));
    const r = flowOrder(items('n1', 'n4', 'n2', 'n5', 'n3'), flows);
    expect(r.byFlow).toBe(true);
    expect(ids(r)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });

  it('标题、批注这类线外的件名次不动（标题不会被挤到最后）', () => {
    const flows = [{ from: 'b', to: 'a' }];
    expect(ids(flowOrder(items('title', 'a', 'note', 'b'), flows))).toEqual(['title', 'b', 'note', 'a']);
  });

  it('分叉：同一层按位置先后', () => {
    const flows = [{ from: 'root', to: 'y' }, { from: 'root', to: 'x' }];
    expect(ids(flowOrder(items('x', 'root', 'y'), flows))).toEqual(['root', 'x', 'y']);
  });

  it('成环的部分退回位置序，不丢件', () => {
    const flows = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'c', to: 'a' }];
    const r = flowOrder(items('a', 'b', 'c'), flows);
    expect(ids(r).sort()).toEqual(['a', 'b', 'c']);
    expect(ids(r)[0]).toBe('c');   // c 入度 0 先出，a/b 成环按位置补
  });

  it('没有 flow 线（或线的端点不在组里）：原样返回，byFlow=false', () => {
    const r = flowOrder(items('a', 'b'), [{ from: 'a', to: '组外' }]);
    expect(r.byFlow).toBe(false);
    expect(ids(r)).toEqual(['a', 'b']);
  });
});
