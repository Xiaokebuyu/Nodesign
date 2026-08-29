/** 断流看门狗（2026-08-29 proj_mtexu1kp 现场）：静默也算死，且只咬一次、活流不误咬。 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { armIdleWatchdog, idleMsFromEnv } from './stream-watchdog.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('armIdleWatchdog', () => {
  it('⭐ 静默超过 idleMs → onIdle 恰好一次', async () => {
    const s = new PassThrough();
    let fired = 0;
    armIdleWatchdog(s, { idleMs: 40, checkMs: 10, onIdle: () => { fired += 1; } });
    await sleep(120);
    expect(fired).toBe(1);
  });

  it('有字节在流就不咬（data 重置计时）', async () => {
    const s = new PassThrough();
    let fired = 0;
    armIdleWatchdog(s, { idleMs: 60, checkMs: 10, onIdle: () => { fired += 1; } });
    for (let i = 0; i < 5; i += 1) { s.write('x'); await sleep(25); }
    expect(fired).toBe(0);
    s.end();
  });

  it('流正常收尾（end/close）后解除，不再计时', async () => {
    const s = new PassThrough();
    let fired = 0;
    armIdleWatchdog(s, { idleMs: 30, checkMs: 10, onIdle: () => { fired += 1; } });
    s.end();
    s.resume();
    await sleep(80);
    expect(fired).toBe(0);
  });

  it('idleMsFromEnv：默认 180s，环境变量可调、垃圾值回默认', () => {
    delete process.env.NODESIGN_INGRESS_IDLE_MS;
    expect(idleMsFromEnv()).toBe(180000);
    process.env.NODESIGN_INGRESS_IDLE_MS = '30000';
    expect(idleMsFromEnv()).toBe(30000);
    process.env.NODESIGN_INGRESS_IDLE_MS = 'abc';
    expect(idleMsFromEnv()).toBe(180000);
    delete process.env.NODESIGN_INGRESS_IDLE_MS;
  });
});
