import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTranscript, findDebugLog, summarizeLine, readTranscript } from './session-transcript.js';

const SID = 'ed914e35-4b50-4afe-b60b-5c0aeab304c9';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-transcript-'));
  const proj = path.join(dir, 'projects', 'C--Users-x--nodesign-projects-p-shared');
  fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(path.join(dir, 'debug'), { recursive: true });
  const lines = [
    { type: 'user', timestamp: '2026-09-08T11:51:40.000Z', message: { role: 'user', content: 'https://www.andidea.jp/ 参考这个网页' } },
    { type: 'assistant', timestamp: '2026-09-08T12:00:58.000Z', message: { role: 'assistant', stop_reason: 'tool_use', usage: { output_tokens: 25 }, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'ToolSearch', input: { query: '生图 抠图 图像' } }] } },
    { type: 'user', timestamp: '2026-09-08T12:01:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_reference', tool_name: 'mcp__nodesign__open_stage' }, { type: 'image', source: {} }] }] } },
    { type: 'ai-title', aiTitle: 'x' },
    { type: 'assistant', timestamp: '2026-09-08T12:01:08.000Z', message: { role: 'assistant', stop_reason: 'stop_sequence', usage: { output_tokens: 0 }, content: [{ type: 'text', text: 'API Error: 400 ZaiException' }] } },
  ];
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'debug', `${SID}.txt`), 'line1\nAPIConnectionError: ECONNRESET\n');
  return dir;
}

describe('session_transcript / session_debug_log 的读取器', () => {
  it('按 sid 在 projects/* 里找到 jsonl；debug/ 里找到 txt；不合法的 sid 一律 null（不拼路径）', () => {
    const dir = fixture();
    expect(findTranscript(dir, SID)).toMatch(/ed914e35.*\.jsonl$/);
    expect(findDebugLog(dir, SID)).toMatch(/debug[\\/]ed914e35.*\.txt$/);
    expect(findTranscript(dir, '../../etc/passwd')).toBeNull();
    expect(findDebugLog(dir, 'x')).toBeNull();
    expect(findTranscript(dir, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(findTranscript(null, SID)).toBeNull();
  });
  it('每行压成一句：角色 / 工具名与参数 / tool_reference 与图片只留类型；ai-title 这类跳过', () => {
    const dir = fixture();
    const out = readTranscript(findTranscript(dir, SID), { tail: 10 });
    expect(out.totalLines).toBe(5);
    expect(out.shown).toBe(4);
    const l = out.text.split('\n');
    expect(l[0]).toMatch(/^11:51:40 U  text: https:\/\/www\.andidea\.jp/);
    expect(l[1]).toContain('tool_use ToolSearch');
    expect(l[1]).toContain('生图 抠图 图像');
    expect(l[1]).toContain('[stop=tool_use out=25]');
    expect(l[2]).toContain('tool_reference mcp__nodesign__open_stage');
    expect(l[2]).toContain('image');
    expect(l[2]).not.toContain('source');
    expect(l[3]).toContain('API Error: 400');
    expect(summarizeLine('not json')).toBeNull();
    // raw 模式回原始行；tail 截尾
    const raw = readTranscript(findTranscript(dir, SID), { tail: 2, summary: false });
    expect(raw.shown).toBe(2);
    expect(raw.text.split('\n')[1]).toContain('"stop_sequence"');
  });
});
