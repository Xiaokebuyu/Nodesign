import { describe, it, expect, vi } from 'vitest';
import { applySessionEffort } from './session-effort.js';

const deps = ({ query = { applyFlagSettings: vi.fn(async () => {}) } } = {}) => ({
  write: vi.fn(async () => ({ changed: true })),
  getQuerySession: () => (query ? { query, abortController: { signal: { aborted: false } } } : null),
  query,
});

describe('applySessionEffort', () => {
  it('⭐ 合法档 → 落盘 + 跑着的会话当场 applyFlagSettings（按模型换算后的档）', async () => {
    const d = deps();
    const r = await applySessionEffort({ sid: 's1', metaDir: '/m', model: 'claude-opus-5[1m]', effort: 'xhigh' }, d);
    expect(r).toEqual({ ok: true, effort: 'xhigh', applied: true });
    expect(d.write).toHaveBeenCalledWith('/m', 'xhigh');
    expect(d.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' });
  });
  it('这个模型不收这一档 → 400，不落盘', async () => {
    const d = deps();
    const r = await applySessionEffort({ sid: 's1', metaDir: '/m', model: 'claude-haiku-4-5', effort: 'high' }, d);
    expect(r).toMatchObject({ ok: false, status: 400, body: { code: 'EFFORT_UNSUPPORTED' } });
    expect(d.write).not.toHaveBeenCalled();
  });
  it('非法值 → 400', async () => {
    expect((await applySessionEffort({ sid: 's1', metaDir: '/m', model: 'claude-opus-5', effort: 'ultra' }, deps())).body.code).toBe('BAD_EFFORT');
  });
  it('null = 清掉，回到模型默认档（SDK 收到默认档）', async () => {
    const d = deps();
    await applySessionEffort({ sid: 's1', metaDir: '/m', model: 'claude-opus-5[1m]', effort: null }, d);
    expect(d.write).toHaveBeenCalledWith('/m', null);
    expect(d.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'medium' });
  });
  it('没有跑着的会话 → 只落盘；applyFlagSettings 抛错 → 不回滚、applied=false', async () => {
    const idle = deps({ query: null });
    expect((await applySessionEffort({ sid: 's1', metaDir: '/m', model: 'claude-opus-5', effort: 'low' }, idle)).applied).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = deps({ query: { applyFlagSettings: vi.fn(async () => { throw new Error('closed'); }) } });
    const r = await applySessionEffort({ sid: 's1', metaDir: '/m', model: 'claude-opus-5', effort: 'low' }, broken);
    warn.mockRestore();
    expect(r).toEqual({ ok: true, effort: 'low', applied: false });
    expect(broken.write).toHaveBeenCalled();
  });
});
