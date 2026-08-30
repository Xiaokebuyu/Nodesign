/**
 * 条件触发器（2026-08-30）。
 *
 * 这一族断言分三类，重要性递减：
 *   ① **触发语义**：触发的是"穿越"不是"为真"；重启后上膛不击发；once 会退休。
 *      这三条写错，机制会变成噪音源或者哑巴，而且两种都不报错。
 *   ② **写错要能被看见**：语法错、跨类型比较、键不存在，每一种都得指得出哪一行错在哪。
 *   ③ 解析细节。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseTriggers, evalTriggers, readLatch, writeLatch, LATCH_REL, MAX_TRIGGERS,
} from './state-triggers.js';

const fence = (...lines) => ['```nd:triggers', ...lines, '```'].join('\n');
const rows = (o) => Object.entries(o).map(([key, value]) => ({ key, value: String(value) }));

describe('parseTriggers', () => {
  it('读得出条件、档、要说的话', () => {
    const p = parseTriggers(`正文\n\n${fence('- [好感度 >= 5] once -> 她开始主动找你说话')}`);
    expect(p.errors).toEqual([]);
    expect(p.triggers).toHaveLength(1);
    expect(p.triggers[0].mode).toBe('once');
    expect(p.triggers[0].message).toBe('她开始主动找你说话');
    expect(p.triggers[0].cmps).toEqual([{ key: '好感度', op: '>=', value: '5' }]);
  });

  it('&& 连成多个比较（全都成立才算命中）', () => {
    const p = parseTriggers(fence('- [体力 <= 2 && 时间 == 夜] on_cross -> 见底了'));
    expect(p.triggers[0].cmps).toHaveLength(2);
  });

  it('⛔ 写错的行不静默丢，报出行号和原文', () => {
    const p = parseTriggers(fence('- [没有比较符] once -> x', '- [a >= 1] 乱写的档 -> y', '随便一行'));
    expect(p.triggers).toHaveLength(0);
    expect(p.errors).toHaveLength(3);
    expect(p.errors[0]).toMatch(/没有比较符/);
  });

  it('围栏没闭合要说；超过上限要说', () => {
    expect(parseTriggers('```nd:triggers\n- [a >= 1] once -> x').errors.join()).toMatch(/没闭合/);
    const many = parseTriggers(fence(...Array.from({ length: MAX_TRIGGERS + 3 }, (_, i) => `- [k${i} >= 1] once -> m`)));
    expect(many.errors.join()).toMatch(/超过/);
  });

  it('id 只由条件+档决定 —— 改措辞不该把沿状态重置掉', () => {
    const a = parseTriggers(fence('- [a >= 1] once -> 第一版措辞')).triggers[0];
    const b = parseTriggers(fence('- [a >= 1] once -> 换了个说法')).triggers[0];
    expect(a.id).toBe(b.id);
    const c = parseTriggers(fence('- [a >= 1] on_cross -> 第一版措辞')).triggers[0];
    expect(c.id).not.toBe(a.id);
  });
});

describe('⭐ 触发语义（写错就成噪音源或哑巴，两种都不报错）', () => {
  const T = parseTriggers(fence(
    '- [好感度 >= 5] once -> 一次性钩子',
    '- [体力 <= 2] on_cross -> 会来回摆的',
  )).triggers;

  it('⛔ 上膛不击发：沿状态是空的（首跑/重启/文件坏了）时，条件已经为真也不触发', () => {
    // 不这么写的话，每次进程重启都会把所有当前为真的条件重放一遍
    const r = evalTriggers(T, rows({ 好感度: 9, 体力: 1 }), {}, { fresh: true });
    expect(r.fired).toEqual([]);
    expect(r.latch[T[0].id].last).toBe(true);      // 但记下来了
  });

  it('⭐ 触发的是穿越不是为真：假→真那一次响，之后一直真也不再响', () => {
    const s0 = evalTriggers(T, rows({ 好感度: 1, 体力: 9 }), {}, { fresh: true });
    const s1 = evalTriggers(T, rows({ 好感度: 6, 体力: 9 }), s0.latch);
    expect(s1.fired.map((f) => f.message)).toEqual(['一次性钩子']);
    const s2 = evalTriggers(T, rows({ 好感度: 7, 体力: 9 }), s1.latch);
    expect(s2.fired).toEqual([]);
  });

  it('once 响过就退休；on_cross 落回去再穿越会再响', () => {
    let s = evalTriggers(T, rows({ 好感度: 1, 体力: 9 }), {}, { fresh: true });
    s = evalTriggers(T, rows({ 好感度: 6, 体力: 1 }), s.latch);      // 两条都穿越
    expect(s.fired).toHaveLength(2);
    s = evalTriggers(T, rows({ 好感度: 1, 体力: 9 }), s.latch);      // 都落回去
    expect(s.fired).toEqual([]);
    s = evalTriggers(T, rows({ 好感度: 6, 体力: 1 }), s.latch);      // 再穿越
    expect(s.fired.map((f) => f.message)).toEqual(['会来回摆的']);   // once 那条不再响
    expect(s.retired).toBe(1);
  });
});

describe('⛔ 求不出来要出声，不许静默当假', () => {
  it('跨类型的大小比较 → 报错并说清是哪边不是数字', () => {
    const T = parseTriggers(fence('- [时间 >= 戌时] once -> x')).triggers;
    const r = evalTriggers(T, rows({ 时间: '夜' }), {}, { fresh: false });
    expect(r.fired).toEqual([]);
    expect(r.errors.join()).toMatch(/比不了/);
    expect(r.errors.join()).toMatch(/左边不是数字/);
  });

  it('== / != 对文字是合法的（只有大小比较要求数字）', () => {
    const T = parseTriggers(fence('- [时间 == 夜] on_cross -> 天黑了')).triggers;
    const s0 = evalTriggers(T, rows({ 时间: '昼' }), {}, { fresh: true });
    const s1 = evalTriggers(T, rows({ 时间: '夜' }), s0.latch);
    expect(s1.fired.map((f) => f.message)).toEqual(['天黑了']);
    expect(s1.errors).toEqual([]);
  });

  it('键在表里不存在 → 报错，而且沿状态不动（免得表补回来时误判成穿越）', () => {
    const T = parseTriggers(fence('- [不存在的键 >= 1] once -> x')).triggers;
    const r = evalTriggers(T, rows({ a: 1 }), {}, { fresh: false });
    expect(r.errors.join()).toMatch(/表里没有/);
    expect(r.latch[T[0].id]).toEqual({ last: false, fired: 0 });
  });
});

describe('沿状态落盘', () => {
  it('写得进读得出；文件缺失或坏了都退回 fresh（上膛不击发）', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-latch-'));
    expect((await readLatch(ws)).fresh).toBe(true);
    await writeLatch(ws, { abc: { last: true, fired: 1 } });
    const back = await readLatch(ws);
    expect(back.fresh).toBe(false);
    expect(back.latch.abc.fired).toBe(1);

    await fs.writeFile(path.join(ws, LATCH_REL), '{ 坏掉的 json');
    expect((await readLatch(ws)).fresh).toBe(true);
    await fs.rm(ws, { recursive: true, force: true });
  });
});
