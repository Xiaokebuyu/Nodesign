import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { lineageFolds, boardLineage } from './lineage.js';

const slice = (src) => {
  const a = src.indexOf('export function lineageFolds');
  const end = src.indexOf('// ── END-MIRROR');
  const b = end > 0 ? end : src.length;
  return src.slice(a, b).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
};

const df = (from, to) => ({ type: 'derives-from', from, to, by: 'agent' });
const seat = (x = 0, y = 0) => ({ x, y });

describe('lineage 镜像', () => {
  it('lineageFolds / lineageMembers 函数体与 web/src/lib/lineage.js 逐字一致', () => {
    const be = fs.readFileSync(new URL('./lineage.js', import.meta.url), 'utf8');
    const fe = fs.readFileSync(new URL('../../web/src/lib/lineage.js', import.meta.url), 'utf8');
    expect(slice(be)).toContain('export function lineageMembers');
    expect(slice(be)).toBe(slice(fe));
  });

  it('默认收起：旧版藏起、链尾计数', () => {
    const { hidden, stacks } = lineageFolds(['v1', 'v2', 'v3'], { a: df('v2', 'v1'), b: df('v3', 'v2') });
    expect([...hidden].sort()).toEqual(['v1', 'v2']);
    expect(stacks.get('v3')).toEqual({ count: 2, open: false });
  });
});

describe('boardLineage', () => {
  it('只看根层有座位的物件；旧版映射到现役版，新的在前', () => {
    const board = {
      zones: { 素材: seat() },
      objects: { 'site:v1': seat(), 'site:v2': seat(), 'site:v3': seat(), 'x.png': seat() },
      bindings: { a: df('site:v2', 'site:v1'), b: df('site:v3', 'site:v2') },
    };
    const { hidden, tipOf, olds } = boardLineage(board);
    expect([...hidden].sort()).toEqual(['site:v1', 'site:v2']);
    expect(tipOf.get('site:v1')).toBe('site:v3');
    expect(olds.get('site:v3')).toEqual(['site:v2', 'site:v1']);
  });

  it('文件夹层里的改自链不收叠（前端只在根层收）；没座位的端点不参与', () => {
    const board = {
      zones: { 素材: seat() },
      objects: { '素材/a1.png': seat(), '素材/a2.png': seat(), 'b2.png': seat() },
      bindings: { a: df('素材/a2.png', '素材/a1.png'), b: df('b2.png', 'b1.png') },
    };
    expect(boardLineage(board).hidden.size).toBe(0);
  });

  it('分叉不收叠；旧版之间有环也都归到现役版', () => {
    const fork = { objects: { a: seat(), b: seat(), c: seat() }, bindings: { e1: df('b', 'a'), e2: df('c', 'a') } };
    expect(boardLineage(fork).hidden.size).toBe(0);
    const loop = {
      objects: { t: seat(), x: seat(), y: seat(), z: seat() },
      bindings: { e1: df('t', 'x'), e2: df('y', 'x'), e3: df('z', 'y'), e4: df('y', 'z') },
    };
    const { hidden, tipOf } = boardLineage(loop);
    expect([...hidden].sort()).toEqual(['x', 'y', 'z']);
    expect(['x', 'y', 'z'].map(id => tipOf.get(id))).toEqual(['t', 't', 't']);
  });
});
