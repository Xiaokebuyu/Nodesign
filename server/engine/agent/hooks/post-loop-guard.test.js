import { describe, it, expect } from 'vitest';
import { makePostToolUseLoopGuard, LOOP_THRESHOLD } from './post-loop-guard.js';

describe('工具循环检测', () => {
  it('同一工具连调到第 6 次记一条问题并提醒；换工具就清零；第 12 次再提醒一次', async () => {
    const issues = [];
    const h = makePostToolUseLoopGuard({ projectId: 'p', sessionId: 'ed914e35-0000-0000-0000-000000000000', record: (i) => issues.push(i) });
    for (let i = 1; i <= 5; i++) expect(await h({ tool_name: 'ToolSearch' })).toEqual({});
    const out = await h({ tool_name: 'ToolSearch' });
    expect(out.hookSpecificOutput.additionalContext).toContain('连续 6 次');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: 'auto', toolName: 'ToolSearch', signature: 'loop|ed914e35-0000-0000-0000-000000000000|ToolSearch' });
    for (let i = 7; i <= 11; i++) expect(await h({ tool_name: 'ToolSearch' })).toEqual({});
    expect((await h({ tool_name: 'ToolSearch' })).hookSpecificOutput.additionalContext).toContain('连续 12 次');
    expect(await h({ tool_name: 'Read' })).toEqual({});
    for (let i = 0; i < LOOP_THRESHOLD - 1; i++) expect(await h({ tool_name: 'ToolSearch' })).toEqual({});
    expect(await h({ tool_name: 'ToolSearch' })).not.toEqual({});   // 换过工具后重新数到 6
    expect(await h({})).toEqual({});
  });
});
