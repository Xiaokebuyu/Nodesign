import { describe, it, expect } from 'vitest';
import { makePostToolBatchWebSearchProtocol } from './post-web-search.js';
import { createHooks } from '../hooks.js';

const batch = (...names) => ({ hook_event_name: 'PostToolBatch', tool_calls: names.map((n, i) => ({ tool_name: n, tool_use_id: `t${i}`, tool_input: {} })) });

describe('web_search 之后的调查协议（PostToolBatch）', () => {
  it('第一批注整份协议（深度表 / 落纸 / 停止判据），之后每批一句硬规矩', async () => {
    const h = makePostToolBatchWebSearchProtocol();
    const first = (await h(batch('mcp__nodesign__web_search'))).hookSpecificOutput.additionalContext;
    expect(first).toContain('首次注入');
    expect(first).toContain('按问题类型定最低深度');
    expect(first).toContain('notes.md');
    expect(first).toContain('什么时候停');
    const second = (await h(batch('mcp__nodesign__web_search'))).hookSpecificOutput.additionalContext;
    expect(second).not.toContain('首次注入');
    expect(second).toContain('打开至少一个候选');
    expect(second.length).toBeLessThan(300);
  });

  it('⭐ 一条消息里连发三次 web_search = 一批，只注一次', async () => {
    const h = makePostToolBatchWebSearchProtocol();
    const out = await h(batch('mcp__nodesign__web_search', 'mcp__nodesign__web_search', 'mcp__nodesign__web_search'));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
    expect(out.hookSpecificOutput.additionalContext).toContain('首次注入');
  });

  it('这一批没有 web_search → 不插话，也不消耗「首次」', async () => {
    const h = makePostToolBatchWebSearchProtocol();
    expect(await h(batch('mcp__nodesign__read_board', 'Read'))).toEqual({});
    expect((await h(batch('mcp__nodesign__web_search'))).hookSpecificOutput.additionalContext).toContain('首次注入');
  });

  it('装配：挂在 PostToolBatch，PostToolUse 里不再有 web_search 条目（不许两处都注）', () => {
    const hooks = createHooks({});
    expect(hooks.PostToolBatch?.[0]?.hooks?.length).toBe(1);
    expect((hooks.PostToolUse || []).some((e) => /web_search/.test(e.matcher || ''))).toBe(false);
  });
});
