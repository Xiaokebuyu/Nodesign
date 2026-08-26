// 角色收件箱（2026-08-26 块 4）
//
// 这条机制的要害是**两种投递结果不能混**：角色挂着等 = 当场交到手里；
// 没人等 = 进队列，而那时服务端叫不醒它。把后者当成"送达"，用户就会
// 对着一个没人听的板子说话，而且不知道。
import { describe, it, expect, beforeEach } from 'vitest';
import { deliver, waitFor, drain, isWaiting, queueDepth, inboxStates, clearProject, emptyStreakOf, _resetInboxes } from './inbox.js';

const P = 'proj_x';
beforeEach(() => _resetInboxes());

describe('两种投递结果', () => {
  it('没人在等 → queued，并如实报深度', () => {
    expect(deliver(P, 'rp-moli', { text: '你好' })).toEqual({ delivered: 'queued', queueDepth: 1 });
    expect(deliver(P, 'rp-moli', { text: '再说一句' })).toEqual({ delivered: 'queued', queueDepth: 2 });
  });

  it('⭐ 角色挂着等 → waiting，且当场交到它手里', async () => {
    const waiting = waitFor(P, 'rp-moli', 5000);
    // 让 waitFor 先挂上
    await new Promise((r) => { setTimeout(r, 0); });
    expect(isWaiting(P, 'rp-moli')).toBe(true);
    expect(deliver(P, 'rp-moli', { text: '接着写' }).delivered).toBe('waiting');
    const got = await waiting;
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('接着写');
    expect(queueDepth(P, 'rp-moli')).toBe(0);      // 直达的不进队列
  });

  it('队列里有货时 await 立刻返回，不空等', async () => {
    deliver(P, 'rp-moli', { text: '早说的' });
    const got = await waitFor(P, 'rp-moli', 60_000);   // 超时给得很大，真等就会挂死这条测试
    expect(got.map((m) => m.text)).toEqual(['早说的']);
  });

  it('⭐ 超时返回空数组而不是抛错（没人说话是正常情形，不是异常）', async () => {
    const got = await waitFor(P, 'rp-moli', 30);
    expect(got).toEqual([]);
    expect(isWaiting(P, 'rp-moli')).toBe(false);       // 超时后要把自己从等待表里摘掉
  });

  it('每条消息都盖时间戳', () => {
    deliver(P, 'rp-moli', { text: 'x' });
    expect(drain(P, 'rp-moli')[0].at).toMatch(/^\d{4}-/);
  });
});

describe('积压与隔离', () => {
  it('队列满了丢最旧的 —— 用户刚说的比十分钟前那句更该留', () => {
    for (let i = 0; i < 60; i += 1) deliver(P, 'rp-moli', { text: `第${i}句` });
    const all = drain(P, 'rp-moli');
    expect(all).toHaveLength(50);
    expect(all[all.length - 1].text).toBe('第59句');
    expect(all[0].text).toBe('第10句');
  });

  it('不同角色 / 不同项目互不串台', () => {
    deliver(P, 'rp-a', { text: 'A的' });
    deliver(P, 'rp-b', { text: 'B的' });
    deliver('proj_y', 'rp-a', { text: '别的项目' });
    expect(drain(P, 'rp-a').map((m) => m.text)).toEqual(['A的']);
    expect(drain(P, 'rp-b').map((m) => m.text)).toEqual(['B的']);
    expect(drain('proj_y', 'rp-a').map((m) => m.text)).toEqual(['别的项目']);
  });

  it('inboxStates 一次问清谁在等、谁有积压', async () => {
    deliver(P, 'rp-a', { text: 'x' });
    const w = waitFor(P, 'rp-b', 5000);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(inboxStates(P)).toEqual({
      'rp-a': { waiting: false, queued: 1 },
      'rp-b': { waiting: true, queued: 0 },
    });
    clearProject(P);
    await w;
  });
});

describe('会话收摊', () => {
  it('⭐ clearProject 要把挂着的 waiter 放掉（不然它们永远挂着）', async () => {
    const w = waitFor(P, 'rp-moli', 60_000);
    await new Promise((r) => { setTimeout(r, 0); });
    clearProject(P);
    expect(await w).toEqual([]);                 // 放掉，而不是挂到超时
    expect(inboxStates(P)).toEqual({});
  });

  it('只收自己项目的摊', async () => {
    const mine = waitFor(P, 'rp-a', 60_000);
    deliver('proj_y', 'rp-a', { text: '别动我' });
    await new Promise((r) => { setTimeout(r, 0); });
    clearProject(P);
    await mine;
    expect(drain('proj_y', 'rp-a')).toHaveLength(1);
  });
});

describe('散场计数（emptyStreak）', () => {
  it('等空一次就 +1，有人说话就归零', async () => {
    expect(emptyStreakOf(P, 'rp-moli')).toBe(0);
    await waitFor(P, 'rp-moli', 1);
    expect(emptyStreakOf(P, 'rp-moli')).toBe(1);
    await waitFor(P, 'rp-moli', 1);
    expect(emptyStreakOf(P, 'rp-moli')).toBe(2);

    const w = waitFor(P, 'rp-moli', 60_000);
    await new Promise((r) => { setTimeout(r, 0); });
    deliver(P, 'rp-moli', { text: '我在' });
    await w;
    expect(emptyStreakOf(P, 'rp-moli')).toBe(0);   // 有人回来了 = 场还热着
  });

  it('⭐ 积压里取到话也算「有人说话」—— 角色被别的方式唤醒后 check_inbox 拿到的那种', async () => {
    await waitFor(P, 'rp-a', 1);
    expect(emptyStreakOf(P, 'rp-a')).toBe(1);
    deliver(P, 'rp-a', { text: '攒着的一句' });     // 没人在等 → 进队列
    expect(emptyStreakOf(P, 'rp-a')).toBe(1);       // 进队列本身不算
    expect(drain(P, 'rp-a')).toHaveLength(1);
    expect(emptyStreakOf(P, 'rp-a')).toBe(0);       // 取到了才算
  });

  it('空 drain 不动计数（别让轮询把散场判据洗掉）', async () => {
    await waitFor(P, 'rp-b', 1);
    expect(emptyStreakOf(P, 'rp-b')).toBe(1);
    expect(drain(P, 'rp-b')).toEqual([]);
    expect(emptyStreakOf(P, 'rp-b')).toBe(1);
  });

  it('按角色各算各的', async () => {
    await waitFor(P, 'rp-x', 1);
    await waitFor(P, 'rp-x', 1);
    await waitFor(P, 'rp-y', 1);
    expect(emptyStreakOf(P, 'rp-x')).toBe(2);
    expect(emptyStreakOf(P, 'rp-y')).toBe(1);
  });
});
