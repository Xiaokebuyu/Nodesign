import { describe, it, expect } from 'vitest';
import { makePostToolUseWebSearchProtocol } from './post-web-search.js';

describe('web_search 之后的调查协议', () => {
  it('第一次注整份协议（深度表 / 落纸 / 停止判据），之后每次一句硬规矩', async () => {
    const h = makePostToolUseWebSearchProtocol();
    const first = (await h({ tool_name: 'mcp__nodesign__web_search' })).hookSpecificOutput.additionalContext;
    expect(first).toContain('首次注入');
    expect(first).toContain('按问题类型定最低深度');
    expect(first).toContain('notes.md');
    expect(first).toContain('什么时候停');
    const second = (await h({ tool_name: 'mcp__nodesign__web_search' })).hookSpecificOutput.additionalContext;
    expect(second).not.toContain('首次注入');
    expect(second).toContain('打开至少一个候选');
    expect(second.length).toBeLessThan(300);
  });
});
