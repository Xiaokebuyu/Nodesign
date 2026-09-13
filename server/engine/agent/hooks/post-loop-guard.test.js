import { describe, it, expect } from 'vitest';
import { makePostToolBatchLoopGuard, LOOP_THRESHOLD } from './post-loop-guard.js';

const batch = (...names) => ({ hook_event_name: 'PostToolBatch', tool_calls: names.map((tool_name) => ({ tool_name, tool_input: {} })) });

describe('工具循环检测（按轮）', () => {
  it('同一工具连调到第 6 轮记一条问题并提醒；换工具就清零；第 12 轮再提醒一次', async () => {
    const issues = [];
    const h = makePostToolBatchLoopGuard({ projectId: 'p', sessionId: 'ed914e35-0000-0000-0000-000000000000', record: (i) => issues.push(i) });
    for (let i = 1; i <= 5; i++) expect(await h(batch('ToolSearch'))).toEqual({});
    const out = await h(batch('ToolSearch'));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolBatch' });
    expect(out.hookSpecificOutput.additionalContext).toContain('连续 6 轮');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: 'auto', toolName: 'ToolSearch', signature: 'loop|ed914e35-0000-0000-0000-000000000000|ToolSearch' });
    for (let i = 7; i <= 11; i++) expect(await h(batch('ToolSearch'))).toEqual({});
    expect((await h(batch('ToolSearch'))).hookSpecificOutput.additionalContext).toContain('连续 12 轮');
    expect(await h(batch('Read'))).toEqual({});
    for (let i = 0; i < LOOP_THRESHOLD - 1; i++) expect(await h(batch('ToolSearch'))).toEqual({});
    expect(await h(batch('ToolSearch'))).not.toEqual({});   // 换过工具后重新数到 6
    expect(await h({})).toEqual({});
  });

  it('⭐ 09-13 一条消息里并行 6 次同一工具只算一轮，不提醒（并行扩表后 prompt 鼓励这么发）', async () => {
    const issues = [];
    const h = makePostToolBatchLoopGuard({ sessionId: 's', record: (i) => issues.push(i) });
    const six = Array(6).fill('mcp__nodesign__generate_image');
    expect(await h(batch(...six))).toEqual({});
    expect(await h(batch(...Array(8).fill('mcp__nodesign__web_search')))).toEqual({});
    expect(issues).toEqual([]);
  });

  it('一轮里混了别的工具算中间有别的工具，清零', async () => {
    const h = makePostToolBatchLoopGuard({ sessionId: 's', record: () => {} });
    for (let i = 1; i <= 5; i++) await h(batch('Read'));
    expect(await h(batch('Read', 'Grep'))).toEqual({});
    for (let i = 1; i <= 5; i++) expect(await h(batch('Read'))).toEqual({});
    expect(await h(batch('Read'))).not.toEqual({});
  });
});
