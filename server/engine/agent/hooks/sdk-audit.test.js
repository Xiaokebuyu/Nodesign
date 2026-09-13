import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeStopFailureAudit, makeNotificationAudit, makeModelSwitchAudit } from './sdk-audit.js';
import { createHooks } from '../hooks.js';

let logs;
beforeEach(() => { logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]; });
afterEach(() => { logs.forEach((s) => s.mockRestore()); });

describe('sdk-audit 钩子', () => {
  it('StopFailure 进问题库，签名按错误类型聚合，返回 {}', async () => {
    const record = vi.fn();
    const out = await makeStopFailureAudit({ projectId: 'p1', sessionId: 's1', record })({
      hook_event_name: 'StopFailure', session_id: 's1', error: 'server_error', error_details: '529 overloaded', last_assistant_message: '正在写',
    });
    expect(out).toEqual({});
    expect(record.mock.calls[0][0]).toMatchObject({ toolName: 'sdk:stop_failure', signature: 'stop-failure:server_error', projectId: 'p1', sessionId: 's1' });
    expect(record.mock.calls[0][0].detail).toContain('529 overloaded');
  });

  it('模型切换：我们自己切（sdk）只记日志，CLI 自动切（auto）进问题库', async () => {
    const record = vi.fn();
    const hook = makeModelSwitchAudit({ projectId: 'p1', sessionId: 's1', record });
    const base = { session_id: 's1', from_model: 'a', to_model: 'b', context_tokens: 1, prompt_cache_warm: true, estimated_cache_write_usd: 0.1 };
    expect(await hook({ ...base, hook_event_name: 'PostModelSwitch', source: 'sdk' })).toEqual({});
    expect(record).not.toHaveBeenCalled();
    await hook({ ...base, hook_event_name: 'PostModelSwitch', source: 'auto' });
    expect(record.mock.calls[0][0]).toMatchObject({ toolName: 'sdk:model_switch_auto', signature: 'model-switch-auto' });
  });

  it('Notification 只记日志，返回 {}', async () => {
    expect(await makeNotificationAudit({ sessionId: 's1' })({ notification_type: 'idle_prompt', message: 'waiting' })).toEqual({});
  });

  it('装配：四个事件挂上了，SessionEnd 没挂（实测不触发）', () => {
    const hooks = createHooks({});   // 跟 hooks-assembly.test.js 同样的最小装配
    for (const ev of ['StopFailure', 'Notification', 'PreModelSwitch', 'PostModelSwitch']) expect(hooks[ev]?.[0]?.hooks?.length).toBe(1);
    expect(hooks.SessionEnd).toBeUndefined();
  });
});

describe('PreCompact 追加保留指令', () => {
  it('返回 systemMessage（CLI 追加到压缩指令后），装配里挂上了', async () => {
    const { makePreCompactHandler, PRE_COMPACT_INSTRUCTIONS } = await import('./lifecycle.js');
    const out = await makePreCompactHandler()({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
    expect(out).toEqual({ systemMessage: PRE_COMPACT_INSTRUCTIONS });
    expect(PRE_COMPACT_INSTRUCTIONS).toContain('原话');
    expect(createHooks({}).PreCompact?.[0]?.hooks?.length).toBe(1);
  });
});
