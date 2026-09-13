/**
 * chat-stream reducer 单测 —— 把真机踩过的坑固化成用例：
 * cross-turn 粘连、WS 重放去重、hydrate 覆盖乐观消息、live_turn 快照接管、
 * 子代理流不吸主线 delta。
 */
import { describe, it, expect } from 'vitest';
import {
  appendTextDelta, clearThinkingStreaming, reduceChatEvent,
  mergeLiveTurnSnapshot, mergeHydrated, keepLiveTools,
} from './chat-stream.js';

describe('appendTextDelta', () => {
  it('同 role 同 runId 连续 delta 累加为一条', () => {
    let m = appendTextDelta([], 'assistant', 'Hello', 'run1');
    m = appendTextDelta(m, 'assistant', ' world', 'run1');
    expect(m).toHaveLength(1);
    expect(m[0].content).toBe('Hello world');
  });

  it('跨 runId 不粘连（Phase A.5 坑）', () => {
    let m = appendTextDelta([], 'assistant', '上一轮', 'run1');
    m = appendTextDelta(m, 'assistant', '这一轮', 'run2');
    expect(m).toHaveLength(2);
  });

  it('hydrate 历史消息不吸新 delta', () => {
    const m = appendTextDelta(
      [{ id: 'h1', role: 'assistant', content: '历史', hydrated: true }],
      'assistant', '新流', 'run1',
    );
    expect(m).toHaveLength(2);
    expect(m[0].content).toBe('历史');
  });

  it('thinking 带流式光标，正文开始时光标关掉', () => {
    let m = appendTextDelta([], 'thinking', '思考中', 'run1');
    expect(m[0].isStreaming).toBe(true);
    m = appendTextDelta(m, 'assistant', '正文', 'run1');
    expect(m[0].isStreaming).toBe(false);
  });

  it('子代理 delta 不吸主线消息（parentToolUseId 隔离）', () => {
    let m = appendTextDelta([], 'assistant', '主线', 'run1');
    m = appendTextDelta(m, 'assistant', '子代理', 'run1', 'toolu_task1');
    expect(m).toHaveLength(2);
    expect(m[1].parentToolUseId).toBe('toolu_task1');
    // 后续子代理 delta 吸进子代理那条
    m = appendTextDelta(m, 'assistant', '继续', 'run1', 'toolu_task1');
    expect(m).toHaveLength(2);
    expect(m[1].content).toBe('子代理继续');
  });

  it('空 text 原引用返回', () => {
    const base = [];
    expect(appendTextDelta(base, 'assistant', '', 'run1')).toBe(base);
  });
});

describe('clearThinkingStreaming', () => {
  it('没有流式 thinking 时原引用返回', () => {
    const base = [{ id: 'a', role: 'assistant', content: 'x' }];
    expect(clearThinkingStreaming(base)).toBe(base);
  });
});

describe('reduceChatEvent — 工具卡生命周期', () => {
  it('started → input → result 三段折成一张卡', () => {
    let m = reduceChatEvent([], { type: 'run.tool_use.started', blockId: 'b1', name: 'Edit', runId: 'r1' });
    expect(m).toHaveLength(1);
    expect(m[0].status).toBe('running');
    m = reduceChatEvent(m, { type: 'run.delta.tool_use', blockId: 'b1', name: 'Edit', input: { file_path: 'a.html' }, runId: 'r1' });
    expect(m).toHaveLength(1);
    expect(m[0].toolInput.file_path).toBe('a.html');
    m = reduceChatEvent(m, { type: 'run.delta.tool_result', blockId: 'b1', ok: true, output: 'ok' });
    expect(m[0].status).toBe('success');
    expect(m[0].toolOutput).toBe('ok');
  });

  it('started 重放（同 blockId）去重', () => {
    let m = reduceChatEvent([], { type: 'run.tool_use.started', blockId: 'b1', name: 'Edit' });
    const same = reduceChatEvent(m, { type: 'run.tool_use.started', blockId: 'b1', name: 'Edit' });
    expect(same).toBe(m);
  });

  it('没出 content_block_start 的边界：delta.tool_use 直接补 push', () => {
    const m = reduceChatEvent([], { type: 'run.delta.tool_use', blockId: 'b2', name: 'Bash', input: { command: 'ls' } });
    expect(m).toHaveLength(1);
    expect(m[0].toolName).toBe('Bash');
  });

  it('无关事件原引用返回', () => {
    const base = [];
    expect(reduceChatEvent(base, { type: 'run.status', status: 'thinking' })).toBe(base);
  });
});

describe('mergeLiveTurnSnapshot', () => {
  it('快照接管：清同 runId 的 delta 累积 + 同 id 工具卡，历史保留', () => {
    const prev = [
      { id: 'old', role: 'assistant', content: '上轮', runId: 'r0' },
      { id: 'd1', role: 'assistant', content: '断线前的半截', runId: 'r1' },
      { id: 'b1', role: 'tool', toolName: 'Edit', status: 'running' },
    ];
    const snap = [
      { id: 's1', role: 'assistant', content: '快照全文', runId: 'r1' },
      { id: 'b1', role: 'tool', toolName: 'Edit', status: 'success' },
    ];
    const merged = mergeLiveTurnSnapshot(prev, snap, 'r1');
    expect(merged.map(m => m.id)).toEqual(['old', 's1', 'b1']);
    expect(merged[2].status).toBe('success');
  });
});

describe('mergeHydrated', () => {
  it('hydrate 空且 current 有内容 → 不 wipe（jsonl 未 flush 竞态）', () => {
    const cur = [{ id: 'u1', role: 'user', content: '刚发的' }];
    expect(mergeHydrated(cur, [])).toBe(cur);
  });

  it('缺乐观 user msg → orphan 保留在尾部', () => {
    const cur = [{ id: 'u1', role: 'user', content: '还在队列里' }];
    const display = [{ id: 'h1', role: 'user', content: '已落盘的' }];
    const merged = mergeHydrated(cur, display);
    expect(merged.map(m => m.id)).toEqual(['h1', 'u1']);
  });

  it('display 已含同内容 user msg → 不重复', () => {
    const cur = [{ id: 'u1', role: 'user', content: '同一条' }];
    const display = [{ id: 'h1', role: 'user', content: '同一条' }];
    expect(mergeHydrated(cur, display)).toBe(display);
  });
});

describe('keepLiveTools（09-13 fable 审查 P2-4）', () => {
  const interrupted = { id: 't1', role: 'tool', toolName: 'Write', status: 'error', interrupted: true, toolError: '没有拿到结果' };
  it('界面上同 id 的卡还在 running → 留界面那张；没在跑的照历史', () => {
    const current = [{ id: 't1', role: 'tool', toolName: 'Write', status: 'running' }, { id: 't2', role: 'tool', status: 'success' }];
    const display = [interrupted, { ...interrupted, id: 't2' }, { id: 'u1', role: 'user', content: 'hi' }];
    const out = keepLiveTools(current, display);
    expect(out[0]).toMatchObject({ id: 't1', status: 'running' });
    expect(out[0].interrupted).toBeUndefined();
    expect(out[1]).toMatchObject({ id: 't2', interrupted: true });
    expect(out[2]).toBe(display[2]);
  });
  it('没有在跑的卡 → 原样返回同一个数组；mergeHydrated 也走这条', () => {
    const display = [interrupted];
    expect(keepLiveTools([], display)).toBe(display);
    const merged = mergeHydrated([{ id: 't1', role: 'tool', status: 'running' }], display);
    expect(merged[0]).toMatchObject({ status: 'running' });
  });
});

