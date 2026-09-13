import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { gatedBrowser, perceptionBrowserSlots } from './browser-slots.js';
import { makeSlotPool } from '../../../../lib/slot-pool.js';

function fakeBrowser(counter) {
  counter.open += 1; counter.peak = Math.max(counter.peak, counter.open);
  const b = new EventEmitter();
  let closed = false;
  b.close = async () => { if (!closed) { closed = true; counter.open -= 1; } };
  return b;
}

describe('perceptionBrowserSlots', () => {
  it('托管 1、本地 2，环境变量可覆盖，非法值不认', () => {
    expect(perceptionBrowserSlots({ env: {}, isLocal: false })).toBe(1);
    expect(perceptionBrowserSlots({ env: {}, isLocal: true })).toBe(2);
    expect(perceptionBrowserSlots({ env: { NODESIGN_PERCEPTION_BROWSERS: '3' }, isLocal: false })).toBe(3);
    expect(perceptionBrowserSlots({ env: { NODESIGN_PERCEPTION_BROWSERS: '0' }, isLocal: false })).toBe(1);
    expect(perceptionBrowserSlots({ env: { NODESIGN_PERCEPTION_BROWSERS: 'abc' }, isLocal: true })).toBe(2);
  });
});

describe('gatedBrowser', () => {
  it('⭐ 并行派发 5 个截图：同时开着的浏览器不超过槽位数，全部关完槽位归零', async () => {
    const pool = makeSlotPool(2);
    const c = { open: 0, peak: 0 };
    const shot = async () => {
      const b = await gatedBrowser(async () => fakeBrowser(c), { pool });
      try { await new Promise((r) => setTimeout(r, 10)); } finally { await b.close(); }
    };
    await Promise.all([shot(), shot(), shot(), shot(), shot()]);
    expect(c.peak).toBe(2);
    expect(pool.used).toBe(0);
  });

  it('exclusive 等所有浏览器关掉才开，开着时别人也进不来', async () => {
    const pool = makeSlotPool(2);
    const c = { open: 0, peak: 0 };
    const a = await gatedBrowser(async () => fakeBrowser(c), { pool });
    let exclusiveOpenedWith = null;
    const px = gatedBrowser(async () => { exclusiveOpenedWith = c.open; return fakeBrowser(c); }, { pool, exclusive: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(exclusiveOpenedWith).toBe(null);
    await a.close();
    const x = await px;
    expect(exclusiveOpenedWith).toBe(0);
    let otherOpened = false;
    const po = gatedBrowser(async () => { otherOpened = true; return fakeBrowser(c); }, { pool });
    await new Promise((r) => setTimeout(r, 0));
    expect(otherOpened).toBe(false);
    await x.close();
    await (await po).close();
    expect(pool.used).toBe(0);
  });

  it('启动失败还槽；浏览器崩了（disconnected）也还；close 之后再崩不会多还', async () => {
    const pool = makeSlotPool(1);
    await expect(gatedBrowser(async () => { throw new Error('no chromium'); }, { pool })).rejects.toThrow('no chromium');
    expect(pool.used).toBe(0);
    const c = { open: 0, peak: 0 };
    const b = await gatedBrowser(async () => fakeBrowser(c), { pool });
    expect(pool.used).toBe(1);
    b.emit('disconnected');
    expect(pool.used).toBe(0);
    await b.close();
    b.emit('disconnected');
    expect(pool.used).toBe(0);
    const again = await gatedBrowser(async () => fakeBrowser(c), { pool });
    expect(pool.used).toBe(1);
    await again.close();
  });
});
