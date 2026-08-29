// mergeAgentSettings 的出口哨兵（2026-08-26）
//
// 为什么对**输出**断言而不是看调用点：这个函数的第二参是显式白名单，
// 往调用点里塞一个它没解构的键 = 静默丢弃、零症状。2026-08-26 真踩过一次
// （crossSessionInbound 跨会话入向闸，调用点写得好好的，到 SDK 手里不存在）。
// 「调用点写了」和「SDK 收到了」是两件事，只有后者算数。
import { describe, it, expect } from 'vitest';
import { mergeAgentSettings } from './memory-config.js';

describe('mergeAgentSettings', () => {
  it('isolation 那侧的键原样带过来', () => {
    const out = mergeAgentSettings({ sandbox: { enabled: true }, permissions: { deny: ['Read(/x)'] } }, {});
    expect(out.sandbox).toEqual({ enabled: true });
    expect(out.permissions).toEqual({ deny: ['Read(/x)'] });
  });

  it('⭐ 跨会话入向闸必须活着到出口（生产会话挂在本机 peer 名册上，靠它拒收）', () => {
    const out = mergeAgentSettings({}, { skipWebFetchPreflight: true, crossSessionInbound: 'refuse' });
    expect(out.crossSessionInbound).toBe('refuse');
  });

  it('自动记忆目录还在（老哨兵）', () => {
    const out = mergeAgentSettings({}, { sharedRoot: '/data/proj_x/shared' });
    expect(out.autoMemoryEnabled).toBe(true);
    expect(out.autoMemoryDirectory).toContain('/data/proj_x/shared');
  });

  it('⭐ 不认识的键当场炸，不静默丢 —— 白名单的代价由加键的人当场付', () => {
    expect(() => mergeAgentSettings({}, { somethingNew: 1 })).toThrow(/不认识的键.*somethingNew/);
  });

  it('三个键一起传时互不吞', () => {
    const out = mergeAgentSettings({ sandbox: { enabled: true } }, {
      skipWebFetchPreflight: true, sharedRoot: '/data/p/shared', crossSessionInbound: 'refuse',
    });
    expect(out.sandbox).toEqual({ enabled: true });
    expect(out.skipWebFetchPreflight).toBe(true);
    expect(out.crossSessionInbound).toBe('refuse');
    expect(out.autoMemoryDirectory).toBeTruthy();
  });
});
