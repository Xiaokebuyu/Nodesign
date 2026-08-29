/**
 * json 结构预览（2026-08-29 占位契约刀 B）。
 * 核心契约只有一条：**裁完还得是合法 json** —— 前端就是靠 parse 得动才画得出树，
 * 裁成不合法就等于什么都没做（还退不回原样，因为调用方以为成功了）。
 */
import { describe, it, expect } from 'vitest';
import { jsonPreview, ELLIPSIS } from './json-preview.js';

const parsed = (s) => JSON.parse(s);

describe('jsonPreview', () => {
  it('⭐ 裁完仍是合法 json（前端画树的前提）', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } }, list: Array.from({ length: 50 }, (_, i) => i) };
    const out = jsonPreview(JSON.stringify(deep));
    expect(() => parsed(out)).not.toThrow();
  });

  it('⭐ 长数组留前几项 + 一句人话说明剩多少（省略要看得见）', () => {
    const out = parsed(jsonPreview(JSON.stringify({ xs: Array.from({ length: 50 }, (_, i) => i) })));
    expect(out.xs.length).toBeLessThan(50);
    expect(out.xs[out.xs.length - 1]).toMatch(new RegExp(`^${ELLIPSIS} \\+\\d+ more`));
  });

  it('⭐ 超深的分支折成「N keys」而不是丢掉', () => {
    const out = parsed(jsonPreview(JSON.stringify({ a: { b: { c: { d: { e: { f: 1, g: 2 } } } } } })));
    const dump = JSON.stringify(out);
    expect(dump).toMatch(/keys|items/);
  });

  it('长字符串截断带省略号', () => {
    const out = parsed(jsonPreview(JSON.stringify({ s: 'x'.repeat(500) })));
    expect(out.s.length).toBeLessThan(500);
    expect(out.s.endsWith(ELLIPSIS)).toBe(true);
  });

  it('短 json 原样通过（没到限就别动它）', () => {
    expect(parsed(jsonPreview('{"a":1,"b":"hi"}'))).toEqual({ a: 1, b: 'hi' });
  });

  it('⭐ 不是合法 json → 返回 null，调用方退回等宽原样（不假装看得懂）', () => {
    expect(jsonPreview('{ 半行就没了')).toBeNull();
    expect(jsonPreview('# 这是 markdown')).toBeNull();
  });

  it('产出有上限（卡面预览不该背着一整个大文件）', () => {
    const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, name: `第${i}行`, tags: ['a', 'b', 'c'] })) };
    expect(jsonPreview(JSON.stringify(big)).length).toBeLessThanOrEqual(4096);
  });
});
