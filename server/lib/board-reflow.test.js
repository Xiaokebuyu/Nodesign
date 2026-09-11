import { describe, it, expect } from 'vitest';
import { reflowGroup, pushDownAfterGrow } from './board-reflow.js';

const m = (id, x, y, w = 200, h = 100) => ({ id, r: { x, y, w, h } });

describe('reflowGroup —— 拿这组当初的布局按现在的线和尺寸再算一遍', () => {
  it('没登记也没点名：column 紧凑堆叠，贴回组原来的左上角', () => {
    const r = reflowGroup([m('a', 100, 50), m('b', 400, 300, 200, 180), m('c', 120, 700)]);
    expect(r.layout).toBe('column');
    expect([...r.pos.entries()]).toEqual([['a', { x: 100, y: 50 }], ['b', { x: 100, y: 166 }], ['c', { x: 100, y: 362 }]]);
  });

  it('登记过 grid 两列：按两列重排，不再压成一列（09-11 桌面会话：组内挪动大半是手工摆回两列）', () => {
    const members = [m('a', 0, 0), m('b', 0, 130), m('c', 0, 260), m('d', 0, 390)];
    const r = reflowGroup(members, { recorded: { layout: 'grid', cols: 2 } });
    expect(r.layout).toBe('grid');
    expect(r.cols).toBe(2);
    const xs = new Set([...r.pos.values()].map((p) => p.x));
    expect(xs.size).toBe(2);                                   // 真是两列
    expect(r.pos.get('a')).toEqual({ x: 0, y: 0 });            // 左上角不动
  });

  it('显式 layout 盖过登记的；flow 走分层（根在上、孩子在下）', () => {
    const members = [m('kid', 0, 0), m('root', 300, 0)];
    const r = reflowGroup(members, { layout: 'flow', recorded: { layout: 'grid', cols: 2 }, bindings: [{ type: 'link', from: 'root', to: 'kid' }] });
    expect(r.layout).toBe('flow');
    expect(r.pos.get('root').y).toBeLessThan(r.pos.get('kid').y);
  });

  it('名次按 flow 线：两列被按行读的顺序排回线的顺序；线外的件留在原名次', () => {
    const members = [m('title', 0, 0), m('n1', 0, 120), m('n3', 240, 120), m('n2', 0, 250)];
    const flows = [{ type: 'flow', from: 'n1', to: 'n2' }, { type: 'flow', from: 'n2', to: 'n3' }];
    const r = reflowGroup(members, { bindings: flows });
    expect(r.byFlow).toBe(true);
    expect(r.order.map((x) => x.id)).toEqual(['title', 'n1', 'n2', 'n3']);
  });

  it('pushDownAfterGrow：变高真会压上才推，只推正下方横向重叠的，被推的几件间距不变', () => {
    const others = [{ id: 'below1', r: { x: 0, y: 116, w: 200, h: 100 } }, { id: 'below2', r: { x: 0, y: 300, w: 200, h: 100 } }, { id: 'side', r: { x: 400, y: 116, w: 200, h: 100 } }];
    expect(pushDownAfterGrow({ x: 0, y: 0, w: 200, h: 90 }, 100, others)).toEqual([]);            // 变矮不收
    expect(pushDownAfterGrow({ x: 0, y: 0, w: 200, h: 100 }, 100, others)).toEqual([]);           // 没变
    const moves = pushDownAfterGrow({ x: 0, y: 0, w: 200, h: 180 }, 100, others);
    expect(moves).toEqual([{ id: 'below1', dy: 80 }, { id: 'below2', dy: 80 }]);                  // 180+16-116
    expect(pushDownAfterGrow({ x: 0, y: 0, w: 200, h: 105 }, 100, [{ id: 'far', r: { x: 0, y: 400, w: 200, h: 100 } }])).toEqual([]);   // 离得远，压不上
  });

  it('登记的是 free（坐标是 agent 给的，机器没法重算）：退回 column', () => {
    expect(reflowGroup([m('a', 0, 0), m('b', 50, 50)], { recorded: { layout: 'free' } }).layout).toBe('column');
  });
});
