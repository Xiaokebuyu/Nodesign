// 直达角色的判据与话术（2026-08-26 块 4）
import { describe, it, expect, vi } from 'vitest';
import { soleRoleTarget, deliveryToast, trySayToRole } from './role-direct.js';

const chalk = (by, byName) => ({ id: 'notes/板书/a.md', title: '一段', by, ...(byName ? { byName } : {}) });

describe('什么时候才直达', () => {
  it('全指着同一个角色 → 直达，带展示名', () => {
    expect(soleRoleTarget([chalk('rp-moli', '墨璃'), chalk('rp-moli', '墨璃')]))
      .toEqual({ slug: 'rp-moli', who: '墨璃' });
  });
  it('⭐ 混选了别人的东西 → 不直达（说不清在跟谁说话）', () => {
    expect(soleRoleTarget([chalk('rp-moli'), chalk('agent')])).toBeNull();
    expect(soleRoleTarget([chalk('rp-moli'), chalk('rp-other')])).toBeNull();
    expect(soleRoleTarget([chalk('rp-moli'), { id: 'x', title: 'deck' }])).toBeNull();
  });
  it('主 agent / 用户写的东西照旧走主 agent', () => {
    expect(soleRoleTarget([chalk('agent')])).toBeNull();
    expect(soleRoleTarget([chalk('user')])).toBeNull();
    expect(soleRoleTarget([])).toBeNull();
  });
  it('没有展示名就报 slug', () => {
    expect(soleRoleTarget([chalk('rp-moli')]).who).toBe('rp-moli');
  });
});

describe('⭐ 两种投递结果分开说（把积压说成送达，用户会对着没人听的板子说话）', () => {
  it('waiting = 送到了', () => {
    expect(deliveryToast('墨璃', 'waiting')).toEqual({ text: '说给墨璃了', kind: 'success' });
  });
  it('queued = 明说它没在等', () => {
    const t = deliveryToast('墨璃', 'queued');
    expect(t.kind).toBe('info');
    expect(t.text).toMatch(/没在等|攒着/);
  });
});

describe('trySayToRole', () => {
  it('不该直达时返回 false，一个请求都不发', async () => {
    const api = { sayToRole: vi.fn() };
    expect(await trySayToRole({ list: [chalk('agent')], api, showToast: () => {} })).toBe(false);
    expect(api.sayToRole).not.toHaveBeenCalled();
  });

  it('直达时把话和上下文一起发出去，并提示结果', async () => {
    const api = { sayToRole: vi.fn().mockResolvedValue({ delivered: 'waiting' }) };
    const toasts = [];
    const ok = await trySayToRole({
      list: [chalk('rp-moli', '墨璃')], projectId: 'p1', text: '继续',
      api, showToast: (t, k) => toasts.push([t, k]),
    });
    expect(ok).toBe(true);
    expect(api.sayToRole).toHaveBeenCalledWith('p1', 'rp-moli', { text: '继续', about: '一段' });
    expect(toasts[0]).toEqual(['说给墨璃了', 'success']);
  });

  it('⭐ 发失败也要说，别静默吞掉用户的话', async () => {
    const api = { sayToRole: vi.fn().mockRejectedValue(new Error('role not found')) };
    const toasts = [];
    await trySayToRole({ list: [chalk('rp-moli', '墨璃')], api, showToast: (t, k) => toasts.push([t, k]) });
    expect(toasts[0][1]).toBe('error');
    expect(toasts[0][0]).toMatch(/没送到墨璃/);
  });
});
