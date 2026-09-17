/**
 * numeric-bounds 单测（2026-09-17）：边界从 zod schema 转出、越界数值夹到边界。
 * 装配层与钩子的真跑测试在 agent/hooks/pre-numeric-clamp.test.js。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { compileNumericBounds, clampToBounds, describeClamp } from './numeric-bounds.js';

const shape = {
  limit: z.number().int().min(1).max(20).optional(),
  settleMs: z.number().min(0).max(10000).optional(),
  free: z.number().optional(),
  query: z.string().max(5).optional(),
  frames: z.array(z.number().min(0).max(100)).max(3).optional(),
  nodes: z.array(z.object({ id: z.string(), w: z.number().min(3).max(120).optional() })).optional(),
  viewport: z.object({ width: z.number().int().min(320).max(3840) }).optional(),
  weights: z.record(z.string(), z.number().min(0).max(1)).optional(),
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('scale'), by: z.number().min(0.3).max(3) }),
    z.object({ op: z.literal('rotate'), by: z.number().min(-180).max(180) }),
    z.object({ op: z.literal('label'), text: z.string().max(10) }),
  ])).optional(),
  maybe: z.number().max(5).nullable().optional(),
  mixed: z.union([z.object({ a: z.number().max(1) }), z.object({ b: z.number().max(2) })]).optional(),
  positive: z.number().positive().max(10).optional(),
  withDefault: z.number().int().min(1).max(8).default(3).optional(),
  tuple: z.tuple([z.number().max(1), z.string()]).optional(),
};
const bounds = compileNumericBounds(shape);
const run = (input) => clampToBounds(bounds, input);

describe('compileNumericBounds', () => {
  it('没有任何有边界数值参数 → null（不进台账）', () => {
    expect(compileNumericBounds({ a: z.string().max(3), b: z.number(), c: z.array(z.string()).max(2) })).toBeNull();
  });
  it('收整个 z.object 也行', () => {
    const b = compileNumericBounds(z.object({ n: z.number().max(2) }));
    expect(clampToBounds(b, { n: 9 }).value).toEqual({ n: 2 });
  });
  it('空输入 / 非对象 → null', () => {
    expect(compileNumericBounds(null)).toBeNull();
    expect(compileNumericBounds(undefined)).toBeNull();
  });
});

describe('clampToBounds', () => {
  it('⭐ 顶层数值越上限 → 夹到上限，并记下改动', () => {
    const r = run({ limit: 30, settleMs: 14000 });
    expect(r.value).toEqual({ limit: 20, settleMs: 10000 });
    expect(r.changes).toEqual([
      { path: 'limit', from: 30, to: 20, bound: 'max' },
      { path: 'settleMs', from: 14000, to: 10000, bound: 'max' },
    ]);
  });
  it('⭐ 下限同样夹', () => {
    const r = run({ limit: 0, viewport: { width: 100 } });
    expect(r.value).toEqual({ limit: 1, viewport: { width: 320 } });
    expect(r.changes.map((c) => c.bound)).toEqual(['min', 'min']);
    expect(r.changes[1].path).toBe('viewport.width');
  });
  it('⭐ 嵌在数组对象里的数值（nodes[].w）逐个夹，其余元素原样', () => {
    const input = { nodes: [{ id: 'a', w: 240 }, { id: 'b', w: 50 }, { id: 'c' }] };
    const r = run(input);
    expect(r.value.nodes).toEqual([{ id: 'a', w: 120 }, { id: 'b', w: 50 }, { id: 'c' }]);
    expect(r.changes).toEqual([{ path: 'nodes[0].w', from: 240, to: 120, bound: 'max' }]);
    expect(r.value.nodes[1]).toBe(input.nodes[1]);   // 没改的元素不复制
  });
  it('数组元素本身是数值、record 的值、tuple 的位置，都按各自边界夹', () => {
    const r = run({ frames: [5, 500], weights: { x: 2, y: 0.5 }, tuple: [7, 'keep'] });
    expect(r.value).toEqual({ frames: [5, 100], weights: { x: 1, y: 0.5 }, tuple: [1, 'keep'] });
    expect(r.changes.map((c) => c.path)).toEqual(['frames[1]', 'weights.x', 'tuple[0]']);
  });
  it('⭐ 判别 union 按 op 找分支，各用各的边界', () => {
    const r = run({ ops: [{ op: 'scale', by: 9 }, { op: 'rotate', by: -400 }, { op: 'label', text: 'hi' }] });
    expect(r.value.ops).toEqual([{ op: 'scale', by: 3 }, { op: 'rotate', by: -180 }, { op: 'label', text: 'hi' }]);
    expect(r.changes.map((c) => `${c.path}:${c.to}`)).toEqual(['ops[0].by:3', 'ops[1].by:-180']);
  });
  it('union 判不出唯一分支（没有判别字段、或 op 不认识）→ 不动，留给 zod', () => {
    expect(run({ mixed: { a: 9 } }).changes).toEqual([]);
    expect(run({ ops: [{ op: 'nope', by: 99 }] }).changes).toEqual([]);
  });
  it('nullable 数值：数字照夹，null 不动', () => {
    expect(run({ maybe: 9 }).value).toEqual({ maybe: 5 });
    expect(run({ maybe: null }).changes).toEqual([]);
  });
  it('带 default 的数值照夹', () => {
    expect(run({ withDefault: 99 }).value).toEqual({ withDefault: 8 });
  });
  it('⭐ 非数字、NaN、Infinity 不动（留给 zod 报错）', () => {
    for (const v of ['30', true, null, NaN, Infinity, -Infinity, { n: 1 }, [30]]) {
      const r = run({ limit: v });
      expect(r.changes).toEqual([]);
      expect(r.value.limit).toBe(v);
    }
  });
  it('⭐ 字符串超长、数组超长不夹（夹等于静默丢内容）', () => {
    const input = { query: 'toolongstring', frames: [1, 2, 3, 4, 5] };
    const r = run(input);
    expect(r.changes).toEqual([]);
    expect(r.value).toBe(input);
    const u = run({ ops: [{ op: 'label', text: 'x'.repeat(50) }] });
    expect(u.changes).toEqual([]);
  });
  it('exclusive 边界（positive）不夹，同一字段的 max 照夹', () => {
    expect(run({ positive: -1 }).changes).toEqual([]);
    expect(run({ positive: 11 }).value).toEqual({ positive: 10 });
  });
  it('没有边界的数值、schema 里没有的键不动', () => {
    const input = { free: 1e9, unknownKey: 1e9 };
    expect(run(input).value).toBe(input);
  });
  it('不改原对象', () => {
    const input = { limit: 30, nodes: [{ id: 'a', w: 240 }] };
    const snap = JSON.stringify(input);
    run(input);
    expect(JSON.stringify(input)).toBe(snap);
  });
  it('JSON 里的 __proto__ 键不会被当成参数', () => {
    const input = JSON.parse('{"__proto__": 99, "limit": 5}');
    expect(run(input).changes).toEqual([]);
  });
  it('夹过的值能过原 zod schema（兜底闸仍在，且夹完不会再被它拒）', () => {
    const input = { limit: 30, nodes: [{ id: 'a', w: 1 }], ops: [{ op: 'rotate', by: 999 }], weights: { k: -3 } };
    expect(z.object(shape).safeParse(input).success).toBe(false);
    expect(z.object(shape).safeParse(run(input).value).success).toBe(true);
  });
});

describe('describeClamp', () => {
  it('说法：参数 X 传了 30，上限 20，已按 20 执行', () => {
    expect(describeClamp({ path: 'limit', from: 30, to: 20, bound: 'max' })).toBe('参数 limit 传了 30，上限 20，已按 20 执行');
    expect(describeClamp({ path: 'nodes[1].w', from: 1, to: 3, bound: 'min' })).toBe('参数 nodes[1].w 传了 1，下限 3，已按 3 执行');
  });
});
