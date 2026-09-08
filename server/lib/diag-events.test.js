import { describe, it, expect, beforeEach } from 'vitest';
import { onDiagEvent, listApiEvents, listToolCalls, sessionDiagStats, attachDiagnosticsTap, _resetDiagEvents } from './diag-events.js';
import { EventBus } from '../engine/agent/events.js';

beforeEach(() => _resetDiagEvents());

describe('诊断分接头', () => {
  it('API 重试 / 每轮用量 / 上下文 / 压缩进 api_events；工具起止配对算耗时进 tool_calls；按会话过滤', () => {
    const sid = 'ed914e35-0000-0000-0000-000000000000';
    onDiagEvent({ type: 'run.api_retry', sessionId: sid, runId: 'r1', attempt: 1, maxRetries: 10, retryDelayMs: 500, errorStatus: null, errorKind: 'unknown' }, 'p1');
    onDiagEvent({ type: 'run.tool_use.started', sessionId: sid, runId: 'r1', round: 2, blockId: 'b1', name: 'ToolSearch' }, 'p1');
    onDiagEvent({ type: 'run.delta.tool_result', sessionId: sid, runId: 'r1', round: 2, blockId: 'b1', name: 'ToolSearch', ok: true }, 'p1');
    onDiagEvent({ type: 'run.round.end', sessionId: sid, runId: 'r1', round: 2, stopReason: 'tool_use', usage: { input_tokens: 57418, output_tokens: 20, cache_read_input_tokens: 0 } }, 'p1');
    onDiagEvent({ type: 'run.context_usage', sessionId: sid, totalTokens: 80000, maxTokens: 1000000, percentage: 8 }, 'p1');
    onDiagEvent({ type: 'run.compact_boundary', sessionId: sid, compactMetadata: { trigger: 'auto' } }, 'p1');
    onDiagEvent({ type: 'run.tool_failure', sessionId: 'other', toolName: 'Read', error: 'File does not exist' }, 'p2');
    onDiagEvent({ type: 'run.delta.text', sessionId: sid, text: 'x'.repeat(5000) }, 'p1');   // 不记
    const api = listApiEvents({ sessionId: sid });
    expect(api.map((e) => e.kind)).toEqual(['retry', 'round', 'compact']);
    expect(api[0]).toMatchObject({ attempt: 1, status: null, error: 'unknown', projectId: 'p1' });
    expect(api[1].usage).toEqual({ in: 57418, out: 20, cacheRead: 0 });
    const calls = listToolCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: 'ToolSearch', ok: true, sessionId: sid, round: 2 });
    expect(calls[0].ms).toBeGreaterThanOrEqual(0);
    expect(calls[1]).toMatchObject({ name: 'Read', ok: false, error: 'File does not exist', sessionId: 'other' });
    expect(listToolCalls({ sessionId: sid })).toHaveLength(1);
    expect(sessionDiagStats(sid)).toMatchObject({ compactions: 1, rounds: 1, contextUsage: { totalTokens: 80000, maxTokens: 1000000, percentage: 8 } });
    expect(sessionDiagStats('nope')).toBeNull();
  });
  it('有界：超过 500 条丢最旧的', () => {
    for (let i = 0; i < 600; i++) onDiagEvent({ type: 'run.tool_failure', sessionId: 's', toolName: `t${i}`, error: 'e' });
    const all = listToolCalls({ limit: 500 });
    expect(all).toHaveLength(500);
    expect(all[0].name).toBe('t100');
  });
  it('挂在 EventBus 上：publish 就进账', () => {
    const bus = new EventBus();
    attachDiagnosticsTap(bus, 'pX');
    bus.publish({ type: 'run.api_retry', sessionId: 's1', attempt: 2, maxRetries: 10, errorStatus: 529, errorKind: 'server_error' });
    expect(listApiEvents()).toHaveLength(1);
    expect(listApiEvents()[0]).toMatchObject({ projectId: 'pX', status: 529 });
  });
});
