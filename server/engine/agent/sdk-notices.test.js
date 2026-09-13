import { describe, it, expect, vi } from 'vitest';
import { handleSdkNotice } from './sdk-notices.js';

const mkCtx = () => ({ runId: 'r1', sessionId: 's1', emitted: [], emit(e) { this.emitted.push(e); } });

describe('handleSdkNotice', () => {
  it('不认识的消息返回 false，交还给调用方的 default 分支', () => {
    const ctx = mkCtx();
    expect(handleSdkNotice(ctx, { type: 'system', subtype: 'no_such_thing' })).toBe(false);
    expect(handleSdkNotice(ctx, { type: 'no_such_type' })).toBe(false);
    expect(ctx.emitted).toEqual([]);
  });

  it('informational → toast，按 level 映射优先级', () => {
    const ctx = mkCtx();
    expect(handleSdkNotice(ctx, { type: 'system', subtype: 'informational', content: '钩子拦下了这句话', level: 'warning' })).toBe(true);
    expect(ctx.emitted[0]).toMatchObject({ type: 'run.notification', key: 'sdk_informational', text: '钩子拦下了这句话', priority: 'warn' });
  });

  it('拒答自动换模型 → 问题库（固定签名）+ toast', () => {
    const ctx = mkCtx(); const record = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleSdkNotice(ctx, {
      type: 'system', subtype: 'model_refusal_fallback', original_model: 'claude-fable-5', fallback_model: 'claude-opus-5',
      direction: 'retry', scope: 'session', request_id: 'req_1', api_refusal_category: 'cyber', content: 'x',
    }, { record });
    warn.mockRestore();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ source: 'auto', toolName: 'sdk:model_refusal', signature: 'model-refusal-fallback', sessionId: 's1' });
    expect(record.mock.calls[0][0].summary).toContain('claude-opus-5');
    expect(ctx.emitted[0]).toMatchObject({ type: 'run.notification', key: 'model_refusal', priority: 'warn' });
  });

  it('拒答未重试 → 另一个签名', () => {
    const ctx = mkCtx(); const record = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleSdkNotice(ctx, { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'm', request_id: null, content: 'x' }, { record });
    warn.mockRestore();
    expect(record.mock.calls[0][0].signature).toBe('model-refusal');
  });

  it('permission_denied → 留痕事件', () => {
    const ctx = mkCtx();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleSdkNotice(ctx, { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason_type: 'rule', decision_reason: 'deny rule', message: 'denied' });
    warn.mockRestore();
    expect(ctx.emitted[0]).toMatchObject({ type: 'run.permission_denied', toolName: 'Bash', toolUseId: 't1', reasonType: 'rule', reason: 'deny rule' });
  });

  it('conversation_reset（顶层 type）→ 事件', () => {
    const ctx = mkCtx();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(handleSdkNotice(ctx, { type: 'conversation_reset', new_conversation_id: 'c2' })).toBe(true);
    log.mockRestore();
    expect(ctx.emitted[0]).toEqual({ type: 'run.conversation_reset', newConversationId: 'c2' });
  });

  it('样本类每个会话每种只打一条日志；commands_changed 清单存到 ctx', () => {
    const ctx = mkCtx();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    handleSdkNotice(ctx, { type: 'active_goal', value: null });
    handleSdkNotice(ctx, { type: 'active_goal', value: null });
    handleSdkNotice(ctx, { type: 'system', subtype: 'commands_changed', commands: [{ name: 'compact' }] });
    const lines = log.mock.calls.map((c) => c[0]);
    log.mockRestore();
    expect(lines.filter((l) => l.includes('active_goal'))).toHaveLength(1);
    expect(ctx.sdkCommands).toEqual([{ name: 'compact' }]);
    expect(ctx.emitted).toEqual([]);
  });
});
