/**
 * 落盘那两条闸：
 *   幽灵座位（2026-08-29）—— 纯尺寸补丁不许给没座位的卡造 (0,0) 假座
 *   删整条（2026-08-31）—— `patch.objects[id] = null` 只许由明确的删除动作发出
 */
import { describe, it, expect } from 'vitest';
import { shouldPersistLayoutPatch, buildBoardPatch } from './useBoardData.js';

describe('shouldPersistLayoutPatch', () => {
  it('没座位 + 纯尺寸补丁（测量回写）→ 拒：不造原点幽灵卡', () => {
    expect(shouldPersistLayoutPatch(undefined, { h: 628 })).toBe(false);
    expect(shouldPersistLayoutPatch(undefined, { w: 300, h: 111 })).toBe(false);
  });
  it('没座位但带坐标（新建/拖拽落点）→ 收', () => {
    expect(shouldPersistLayoutPatch(undefined, { x: 120, y: 80 })).toBe(true);
  });
  it('已有座位 → 什么补丁都收（真值回写正是为了它）', () => {
    expect(shouldPersistLayoutPatch({ x: 24, y: 216 }, { h: 148 })).toBe(true);
    expect(shouldPersistLayoutPatch({ x: 24, y: 216 }, { seat: 'user' })).toBe(true);
  });
});

/**
 * 这一组守的是**别人的字段**。`null` 在服务端是"删掉整条记录"，而条目上挂着
 * tag / by / seat / 实测 w,h / sized / zone / hug —— 生产 148 块真板实测，
 * 光根层就有 1735 条这样的记录（tag 227 / by 307 / seat 183 / 实测尺寸 368）。
 * 「整理」那颗按钮就是靠这条推断把它们一键删掉的。
 */
describe('buildBoardPatch —— 什么时候才发 null', () => {
  const layout = { 'a.png': { x: 10, y: 20, tag: '素材', seat: 'agent', w: 200, h: 148 } };

  it('有座位 → 发座位本身（服务端合并语义，别的字段留着）', () => {
    const p = buildBoardPatch({ dirtyObjects: new Set(['a.png']), layout, removed: new Set() });
    expect(p.objects['a.png']).toEqual(layout['a.png']);
  });

  it('⛔ 没座位又没人说要删 → 一个字都不发（不是删除指令）', () => {
    const p = buildBoardPatch({ dirtyObjects: new Set(['走丢的.png']), layout: {}, removed: new Set() });
    expect(p.objects, '把"脏了但本地没有"当成删除，就是「整理」删光 tag/seat 的那条路').toBeUndefined();
  });

  it('明确删过 → 才发 null', () => {
    const p = buildBoardPatch({ dirtyObjects: new Set(['text:1']), layout: {}, removed: new Set(['text:1']) });
    expect(p.objects).toEqual({ 'text:1': null });
  });

  it('⭐ 自愈：删过但座位又回来了 → 发座位，null 发不出去', () => {
    const p = buildBoardPatch({ dirtyObjects: new Set(['a.png']), layout, removed: new Set(['a.png']) });
    expect(p.objects['a.png']).toEqual(layout['a.png']);
  });

  it('zones 只发坐标，且**没有 null 那一档**（删文件夹走自己的端点）', () => {
    const zones = { 稿件: { x: 24, y: 24, w: 288, h: 240 } };
    const p = buildBoardPatch({ dirtyZones: new Set(['稿件', '已删的夹']), zones, removed: new Set(['已删的夹']) });
    expect(p.zones).toEqual({ 稿件: { x: 24, y: 24 } });
  });

  it('两边都没东西可说 → 空补丁（调用方据此不发请求）', () => {
    expect(buildBoardPatch({ dirtyObjects: new Set(['x']), layout: {}, removed: new Set() })).toEqual({});
  });
});
