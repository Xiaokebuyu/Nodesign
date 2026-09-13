import { describe, it, expect } from 'vitest';
import { sessionMessagesToDisplay } from './session-to-messages.js';
import { mergeLiveTurnSnapshot } from './chat-stream.js';

const assistant = (uuid, blocks) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: blocks } });
const user = (uuid, blocks) => ({ type: 'user', uuid, message: { role: 'user', content: blocks } });

describe('sessionMessagesToDisplay × 没拿到结果的工具（09-13）', () => {
  it('⭐ 整份转录里没有 tool_result 的工具标成被中断的失败，不再默认成功', () => {
    const out = sessionMessagesToDisplay([
      user('u1', [{ type: 'text', text: '做个站' }]),
      assistant('a1', [{ type: 'tool_use', id: 't_ok', name: 'Write', input: {} }, { type: 'tool_use', id: 't_lost', name: 'mcp__nodesign__web_search', input: {} }]),
      user('u2', [{ type: 'tool_result', tool_use_id: 't_ok', content: 'written' }]),
    ]);
    const byId = Object.fromEntries(out.filter((m) => m.role === 'tool').map((m) => [m.id, m]));
    expect(byId.t_ok).toMatchObject({ status: 'success', toolOutput: 'written' });
    expect(byId.t_lost).toMatchObject({ status: 'error', interrupted: true });
    expect(byId.t_lost.toolError).toContain('中断');
  });

  it('CLI 补过 is_error 结果的（用户按停）照旧是那条错误，不被覆盖', () => {
    const out = sessionMessagesToDisplay([
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      user('u2', [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '[Request interrupted by user for tool use]' }]),
    ]);
    expect(out[0]).toMatchObject({ status: 'error', toolError: '[Request interrupted by user for tool use]' });
    expect(out[0].interrupted).toBeUndefined();
  });

  it('还在跑的回合：随后的 live_turn 快照用同 id 的 running 工具卡替换掉「被中断」', () => {
    const hydrated = sessionMessagesToDisplay([assistant('a1', [{ type: 'tool_use', id: 't_live', name: 'Write', input: {} }])]);
    expect(hydrated[0].status).toBe('error');
    const merged = mergeLiveTurnSnapshot(hydrated, [{ id: 't_live', role: 'tool', toolName: 'Write', status: 'running', runId: 'run_1' }], 'run_1');
    expect(merged.filter((m) => m.id === 't_live')).toEqual([{ id: 't_live', role: 'tool', toolName: 'Write', status: 'running', runId: 'run_1' }]);
  });
});
