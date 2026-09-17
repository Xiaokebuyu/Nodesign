/**
 * 没有产物会话时的报错（09-17）：会话空闲会被回收，agent 隔几分钟回来用 live:true 只看到
 * 「没开」会以为自己没开过。报错要说清会自动回收、重新 artifact_open 即可，时长按 IDLE_MS 实际值说。
 */
import { describe, it, expect } from 'vitest';
import { noSessionText, withSession, lockSession, _limits } from './session.js';

describe('noSessionText', () => {
  it('默认按 IDLE_MS 说（未配 ND_ARTIFACT_SESSION_IDLE_MS 时是 3 分钟）', () => {
    if (!process.env.ND_ARTIFACT_SESSION_IDLE_MS) expect(_limits.IDLE_MS).toBe(3 * 60 * 1000);
    const t = noSessionText();
    expect(t).toContain('call artifact_open first');
    expect(t).toContain(`closed automatically after about ${Math.round(_limits.IDLE_MS / 60000)} minutes idle`);
    expect(t).toContain('just artifact_open again');
  });
  it('不足一分钟的配置按秒说，不报成 0 分钟', () => {
    expect(noSessionText(45_000)).toContain('about 45 seconds idle');
  });
  it('withSession / lockSession 没有会话时抛的就是这句', async () => {
    await expect(withSession('proj_none_0917', async () => 1)).rejects.toThrow(noSessionText());
    await expect(lockSession('proj_none_0917b')).rejects.toThrow(noSessionText());
  });
});
