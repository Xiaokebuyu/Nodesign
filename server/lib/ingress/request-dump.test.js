import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumpRequestShape } from './request-dump.js';

describe('dumpRequestShape（ND_INGRESS_DUMP_DIR 量具）', () => {
  it('没给目录 → 不落盘不报错', () => {
    expect(dumpRequestShape({ model: 'x' }, 'sid', '')).toBeNull();
  });
  it('给了目录 → 落 system 全文 / tools 名 / 最后一条 user 文本，不落 tool_result 正文', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-dump-'));
    const body = {
      model: 'deepseek-v4-flash-vision',
      system: [{ type: 'text', text: 'You are X' }],
      tools: [{ name: 'Read', input_schema: {} }, { name: 'mcp__nodesign__place' }],
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '机密正文' }, { type: 'text', text: '第二句' }] },
      ],
    };
    const file = dumpRequestShape(body, 'abcdef123456', dir);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.model).toBe('deepseek-v4-flash-vision');
    expect(j.system[0].text).toBe('You are X');
    expect(j.tools).toEqual(['Read', 'mcp__nodesign__place']);
    expect(j.messages).toBe(3);
    expect(j.lastUserText).toBe('第二句');
    expect(JSON.stringify(j)).not.toContain('机密正文');
    expect(path.basename(file)).toMatch(/-abcdef12\.json$/);
  });
});
