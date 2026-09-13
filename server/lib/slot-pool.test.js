import { describe, it, expect } from 'vitest';
import { makeSlotPool } from './slot-pool.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('makeSlotPool', () => {
  it('同时持有的槽位不超过 size，还一个放一个', async () => {
    const pool = makeSlotPool(2);
    let peak = 0; let active = 0;
    const job = () => pool.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
    expect(pool.used).toBe(0);
    expect(pool.waiting).toBe(0);
  });

  it('先来先服务：队头要独占时后面的小请求不插队（独占不会被饿死）', async () => {
    const pool = makeSlotPool(2);
    const order = [];
    const r1 = await pool.acquire();
    const pExclusive = pool.acquire(Infinity).then((rel) => { order.push('exclusive'); return rel; });
    const pSmall = pool.acquire().then((rel) => { order.push('small'); return rel; });
    await tick();
    // 还空着一个槽，但队头是独占，小请求不许先拿
    expect(order).toEqual([]);
    r1();
    const rx = await pExclusive;
    await tick();
    expect(order).toEqual(['exclusive']);
    expect(pool.used).toBe(2);
    rx();
    (await pSmall)();
    expect(order).toEqual(['exclusive', 'small']);
    expect(pool.used).toBe(0);
  });

  it('release 幂等；fn 抛错也还槽', async () => {
    const pool = makeSlotPool(1);
    const rel = await pool.acquire();
    rel(); rel();
    expect(pool.used).toBe(0);
    await expect(pool.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pool.used).toBe(0);
    // 还错了次数的话，这里会出现 used 为负、两个同时拿到
    const a = await pool.acquire();
    let second = false;
    pool.acquire().then(() => { second = true; });
    await tick();
    expect(second).toBe(false);
    a();
  });

  it('size 非法按 1 算；weight 超过 size 按 size 算', async () => {
    expect(makeSlotPool(0).size).toBe(1);
    expect(makeSlotPool('x').size).toBe(1);
    const pool = makeSlotPool(3);
    const rel = await pool.acquire(99);
    expect(pool.used).toBe(3);
    rel();
  });

  it('⭐ 按来源轮转（09-13 fable 审查 P1-2）：A 一口气排 6 个，B 后到的 1 个只等 A 正在跑的那一个', async () => {
    const pool = makeSlotPool(1);
    const order = [];
    const job = (key, name) => pool.run(async () => { order.push(name); await tick(); }, 1, key);
    const all = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((n) => job('A', n));
    await tick();   // a1 已经在跑，a2..a6 在排队
    all.push(job('B', 'b1'));
    all.push(job('C', 'c1'));
    all.push(job('B', 'b2'));
    await Promise.all(all);
    expect(order.slice(0, 4)).toEqual(['a1', 'b1', 'c1', 'a2']);
    expect(order.indexOf('b2')).toBeLessThan(order.indexOf('a4'));
    // 同一来源内部仍是先来先服务
    expect(order.filter((n) => n.startsWith('a'))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    expect(pool.used).toBe(0);
    expect(pool.waiting).toBe(0);
  });

  it('轮转不饿死独占：轮到的独占拿不到时整体等，别的来源的小请求不插队', async () => {
    const pool = makeSlotPool(2);
    const order = [];
    const r = await pool.acquire(1, 'A');
    const px = pool.acquire(Infinity, 'B').then((rel) => { order.push('B-exclusive'); return rel; });
    const ps = pool.acquire(1, 'C').then((rel) => { order.push('C-small'); return rel; });
    await tick();
    expect(order).toEqual([]);
    r();
    (await px)();
    (await ps)();
    expect(order).toEqual(['B-exclusive', 'C-small']);
  });
});
