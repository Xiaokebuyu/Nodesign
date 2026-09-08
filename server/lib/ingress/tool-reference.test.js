import { describe, it, expect } from 'vitest';
import { flattenToolReferences, toolReferenceText } from './tool-reference.js';

describe('flattenToolReferences（Anthropic 透传腿）', () => {
  it('tool_result 里的 tool_reference 块换成一条 text；别的块不动；没有就不改', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }, { type: 'tool_reference', tool_name: 'a' }, { type: 'tool_reference', tool_name: 'b' }] }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'plain' }] }] },
    ];
    expect(flattenToolReferences(msgs)).toBe(true);
    const c = msgs[1].content[0].content;
    expect(c.map((b) => b.type)).toEqual(['text', 'text']);
    expect(c[1].text).toBe(toolReferenceText(['a', 'b']));
    expect(msgs[2].content[0].content).toEqual([{ type: 'text', text: 'plain' }]);
    expect(flattenToolReferences(msgs)).toBe(false);
    expect(flattenToolReferences([{ role: 'user', content: 'str' }])).toBe(false);
  });
});
