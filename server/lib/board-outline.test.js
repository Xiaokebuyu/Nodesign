/**
 * 板书树刀一：大纲（2026-09-17）。
 * 钉住父子推断的四条规则与它们的先后，以及脏数据（环、父不在这一层）不许让大纲塌掉。
 */
import { describe, it, expect } from 'vitest';
import { inferParents, outlineOf } from './board-outline.js';

const at = (id, x, y, extra = {}) => ({ id, entry: { x, y, ...extra } });
const ids = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.id}`);

describe('inferParents', () => {
  it('reply_to 压过 anchor，anchor 压过同 tag 的组长', () => {
    const items = [at('a', 0, 0), at('b', 0, 200), at('c', 0, 400, { tag: '线' }), at('d', 0, 600, { tag: '线' })];
    const excerpts = new Map([
      ['b', { anchor: 'a' }],
      ['c', { replyTo: 'b', anchor: 'a' }],
    ]);
    const p = inferParents(items, { excerpts });
    expect(p.get('a')).toBeNull();
    expect(p.get('b')).toBe('a');
    expect(p.get('c')).toBe('b');
    expect(p.get('d')).toBe('c');      // 同 tag 的组长（c 是 #线 里阅读序第一件）
  });

  it('annotates 线也算「注挂在它说的东西上」；父不在这一层就当根', () => {
    const items = [at('site:x', 0, 0), at('text:n1', 400, 0)];
    const bindings = { e1: { type: 'annotates', from: 'text:n1', to: 'site:x' }, e2: { type: 'annotates', from: 'text:n1', to: '别层的' } };
    expect(inferParents(items, { bindings }).get('text:n1')).toBe('site:x');
    expect(inferParents([at('text:n1', 0, 0)], { bindings }).get('text:n1')).toBeNull();
  });

  it('⭐ 环不许让大纲塌掉：断开一处成树，两件都还在，谁也不会自认爹', () => {
    const items = [at('a', 0, 0), at('b', 0, 200)];
    const excerpts = new Map([['a', { replyTo: 'b' }], ['b', { replyTo: 'a' }]]);
    const p = inferParents(items, { excerpts });
    const roots = [...p.entries()].filter(([, v]) => v === null).map(([k]) => k);
    expect(roots).toHaveLength(1);                       // 恰好断开一处
    const rows = outlineOf(items, { excerpts });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(Math.max(...rows.map((r) => r.depth))).toBe(1);
  });
});

describe('outlineOf', () => {
  it('先根后子、同辈按阅读序（先上后下、先左后右），缩进即深度', () => {
    const items = [
      at('根1', 0, 0), at('子A', 100, 100), at('子B', 500, 100), at('孙', 100, 300), at('根2', 0, 900),
    ];
    const excerpts = new Map([
      ['子A', { replyTo: '根1' }], ['子B', { replyTo: '根1' }], ['孙', { replyTo: '子A' }],
    ]);
    expect(ids(outlineOf(items, { excerpts }))).toEqual(['根1', '  子A', '    孙', '  子B', '根2']);
  });

  it('children 数出整棵子树的件数（给折起的枝写一行用）', () => {
    const items = [at('r', 0, 0), at('k1', 0, 100), at('k2', 0, 200)];
    const excerpts = new Map([['k1', { replyTo: 'r' }], ['k2', { replyTo: 'k1' }]]);
    const rows = outlineOf(items, { excerpts });
    expect(rows[0]).toMatchObject({ id: 'r', depth: 0, children: 2 });
    expect(rows[1]).toMatchObject({ id: 'k1', depth: 1, children: 1 });
  });

  it('⭐ 同 tag 是一组不是一条链：成员都挂在组长下面，40 节点的草图只缩进一层', () => {
    const items = [at('n1', 0, 0, { tag: 'sk' }), ...Array.from({ length: 39 }, (_, i) => at(`n${i + 2}`, (i % 8) * 120, 200 + Math.floor(i / 8) * 120, { tag: 'sk' }))];
    const rows = outlineOf(items, {});
    expect(rows[0].id).toBe('n1');
    expect(Math.max(...rows.map((r) => r.depth))).toBe(1);
    expect(rows[0].children).toBe(39);
  });

  it('一件都不丢：所有件都在大纲里出现且只出现一次', () => {
    const items = [at('a', 0, 0), at('b', 0, 100, { tag: 't' }), at('c', 0, 200, { tag: 't' }), at('d', 900, 0)];
    const rows = outlineOf(items, { excerpts: new Map([['a', { replyTo: 'd' }]]) });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
