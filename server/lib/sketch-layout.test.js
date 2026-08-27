import { describe, it, expect } from 'vitest';
import { shapePath, layoutNodes, resolveTemplate, findSpot, textBox, UNIT } from './sketch-layout.js';

const PATH_RE = /^[\dMLQCZ ,.\-eE]+$/;   // = board-sanitize 的涂鸦字符白名单

describe('sketch-layout', () => {
  it('每种形状的路径都过涂鸦白名单、确定性、尺寸含 pad', () => {
    for (const kind of ['rect', 'ellipse', 'circle', 'line', 'arrow', 'underline']) {
      const a = shapePath(kind, { w: 120, h: 60, to: { x: 120, y: 30 } }, 's1');
      const b = shapePath(kind, { w: 120, h: 60, to: { x: 120, y: 30 } }, 's1');
      expect(a.d, kind).toMatch(PATH_RE);
      expect(a.d, kind).toBe(b.d);
      expect(a.w, kind).toBeGreaterThan(0);
      expect(a.h, kind).toBeGreaterThan(0);
    }
    expect(shapePath('rect', { w: 100, h: 50 }, 'x').d).not.toBe(shapePath('rect', { w: 100, h: 50 }, 'y').d);
    expect(shapePath('blob', {}, 'x')).toBeNull();
  });
  it('模板：column 竖排不重叠；grid 按列；mindmap 第一个居中其余环绕；free 认网格', () => {
    const nodes = [1, 2, 3, 4, 5].map(i => ({ key: `n${i}`, w: 100, h: 40 }));
    const col = layoutNodes(nodes, { template: 'column' });
    expect(col.get('n2').y).toBeGreaterThanOrEqual(40);
    const grid = layoutNodes(nodes, { template: 'grid', cols: 2 });
    expect(grid.get('n3').y).toBeGreaterThan(0);
    expect(grid.get('n2').x).toBeGreaterThan(0);
    const mm = layoutNodes(nodes, { template: 'mindmap' });
    const c = mm.get('n1');
    const others = ['n2', 'n3', 'n4', 'n5'].map(k => mm.get(k));
    for (const o of others) expect(Math.hypot(o.x - c.x, o.y - c.y)).toBeGreaterThan(80);
    const free = layoutNodes([{ key: 'a', w: 50, h: 20, at: { x: 2, y: 3 } }, { key: 'b', w: 50, h: 20 }], { template: 'free' });
    expect(free.get('a')).toEqual({ x: 2 * UNIT, y: 3 * UNIT });
    expect(free.get('b').y).toBeGreaterThan(3 * UNIT + 20);
  });
  it('findSpot：锚右侧优先、撞了往下让、没锚排内容底下', () => {
    const near = { x: 0, y: 0, w: 200, h: 100 };
    const s1 = findSpot({ w: 100, h: 50, near, obstacles: [near] });
    expect(s1.side).toBe('right');
    const s2 = findSpot({ w: 100, h: 50, near, obstacles: [near, { x: 232, y: 0, w: 100, h: 300 }] });
    expect(s2.y).toBeGreaterThan(0);
    const s3 = findSpot({ w: 100, h: 50, contentBottom: 500 });
    expect(s3.y).toBeGreaterThan(500);
  });
  it('textBox：md 比 plain 宽、按行估高', () => {
    const p = textBox('短句', 'md');
    const m = textBox('# 标题\n- 一\n- 二\n- 三', 'md', { md: true });
    expect(m.w).toBeGreaterThan(p.w);
    expect(m.h).toBeGreaterThan(p.h);
  });
});

describe('布局认线（08-27：「摊一堆字」的机器根源修复）', () => {
  const N = (key, w = 100, h = 40) => ({ key, w, h });

  it('⭐ auto + 有图内边 → flow 分层：链条按层往下走', () => {
    const nodes = [N('a'), N('b'), N('c')];
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
    const pos = layoutNodes(nodes, { template: 'auto', edges });
    expect(pos.get('a').y).toBeLessThan(pos.get('b').y);
    expect(pos.get('b').y).toBeLessThan(pos.get('c').y);
  });

  it('菱形：两个中间节点同层并排，汇点再下一层', () => {
    const nodes = [N('a'), N('b'), N('c'), N('d')];
    const edges = [
      { from: 'a', to: 'b' }, { from: 'a', to: 'c' },
      { from: 'b', to: 'd' }, { from: 'c', to: 'd' },
    ];
    const pos = layoutNodes(nodes, { template: 'flow', edges });
    expect(pos.get('b').y).toBe(pos.get('c').y);
    expect(pos.get('d').y).toBeGreaterThan(pos.get('b').y);
    expect(pos.get('b').x).not.toBe(pos.get('c').x);
  });

  it('⭐ 带环不炸：回边断开，仍给每个节点一个位置', () => {
    const nodes = [N('a'), N('b'), N('c')];
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }];
    const pos = layoutNodes(nodes, { template: 'flow', edges });
    expect(pos.size).toBe(3);
  });

  it('auto 无边照旧 column/grid；显式 column 不受 edges 影响（老会话行为不变）', () => {
    const nodes = [N('a'), N('b'), N('c')];
    expect(resolveTemplate(nodes, {})).toBe('column');
    const col = layoutNodes(nodes, { template: 'column', edges: [{ from: 'a', to: 'c' }] });
    expect(col.get('a').x).toBe(col.get('c').x);
  });

  it('⭐ mindmap 枢纽按度数选，不再迷信第一个', () => {
    const nodes = [N('leaf1'), N('hub'), N('leaf2'), N('leaf3')];
    const edges = [
      { from: 'hub', to: 'leaf1' }, { from: 'hub', to: 'leaf2' }, { from: 'hub', to: 'leaf3' },
    ];
    const pos = layoutNodes(nodes, { template: 'mindmap', edges });
    // 枢纽站中心：它的中心点离原点最近，叶子全在环上
    const dist = (k) => {
      const p = pos.get(k); const n = nodes.find((x) => x.key === k);
      return Math.hypot(p.x + n.w / 2, p.y + n.h / 2);
    };
    expect(dist('hub')).toBeLessThan(Math.min(dist('leaf1'), dist('leaf2'), dist('leaf3')));
  });
});

describe('节点级拉力（08-27 产物锚 v2）：连着谁排向谁', () => {
  const N = (key, w = 100, h = 40) => ({ key, w, h });

  it('⭐ flow 层内：拉向左侧产物的节点排左、右侧的排右（无视入参顺序）', () => {
    const nodes = [N('root'), N('toRight'), N('toLeft')];
    const edges = [{ from: 'root', to: 'toRight' }, { from: 'root', to: 'toLeft' }];
    const pull = new Map([
      ['toRight', { x: 5000, y: 0 }],
      ['toLeft', { x: -5000, y: 0 }],
    ]);
    const pos = layoutNodes(nodes, { template: 'flow', edges, pull });
    expect(pos.get('toLeft').x).toBeLessThan(pos.get('toRight').x);
    expect(pos.get('toLeft').y).toBe(pos.get('toRight').y);   // 仍同层
  });

  it('⭐ mindmap 环位：拉向上方产物的叶子占上侧环位', () => {
    const nodes = [N('hub'), N('a'), N('b'), N('up')];
    const edges = [
      { from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }, { from: 'hub', to: 'up' },
    ];
    const pull = new Map([['up', { x: 0, y: -8000 }]]);
    // 单锚时质心退化，方位要靠 pullOrigin（真实图心，write-on-board 落位后传）
    const pos = layoutNodes(nodes, { template: 'mindmap', edges, pull, pullOrigin: { x: 0, y: 0 } });
    const cy = (k) => { const p = pos.get(k); const n = nodes.find((x) => x.key === k); return p.y + n.h / 2; };
    expect(cy('up')).toBeLessThan(cy('hub'));
    expect(cy('up')).toBeLessThanOrEqual(Math.min(cy('a'), cy('b')));
  });

  it('单锚且没有 pullOrigin：质心退化 → 放弃重排不出鬼方向（bfs 序保底）', () => {
    const nodes = [N('hub'), N('a'), N('b'), N('up')];
    const edges = [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }, { from: 'hub', to: 'up' }];
    const withPull = layoutNodes(nodes, { template: 'mindmap', edges, pull: new Map([['up', { x: 0, y: -8000 }]]) });
    const noPull = layoutNodes(nodes, { template: 'mindmap', edges });
    expect([...withPull.entries()]).toEqual([...noPull.entries()]);
  });

  it('没有拉力时行为不变（parentAvg/入参序照旧）', () => {
    const nodes = [N('a'), N('b'), N('c')];
    const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }];
    const p1 = layoutNodes(nodes, { template: 'flow', edges });
    const p2 = layoutNodes(nodes, { template: 'flow', edges, pull: new Map() });
    expect([...p1.entries()]).toEqual([...p2.entries()]);
  });
});
