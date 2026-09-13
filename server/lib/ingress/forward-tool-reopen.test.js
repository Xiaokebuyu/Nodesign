// 上游回头续写已闭合的 tool_call（2026-09-13 计数）：forward 层收尾时把次数交给 onToolCallReopened，没发生不调
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { forwardOpenAIChat } from './forward-openai-chat.js';
import { noteToolCallReopened } from './tool-call-reopen.js';

function fakeUpstream(handler) {
  return new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })); });
}
function fakeRes() {
  let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  const res = { headersSent: false, writableEnded: false, writeHead() { res.headersSent = true; }, write() { return true; }, end() { res.writableEnded = true; resolveDone(); }, on() {}, once() {}, emit() {}, flushHeaders() {} };
  return { res, done };
}
const chunk = (tool_calls, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: tool_calls ? { tool_calls } : {}, finish_reason: finish }] })}\n\n`;

async function run(chunks) {
  const { srv, port } = await fakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) res.write(c);
      res.end('data: [DONE]\n\n');
    });
  });
  try {
    const { res, done } = fakeRes(); const calls = [];
    forwardOpenAIChat({
      parsed: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } },
      key: 'k', res, sidShort: 't', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false,
      onToolCallReopened: (n) => calls.push(n),
    });
    await done;
    await new Promise((r) => setTimeout(r, 20));   // 'end' 回调在 res.end 之后的同一轮或下一轮
    return calls;
  } finally { srv.close(); }
}

describe('forward × 工具调用交错', () => {
  it('交错一次 → 回调收到 1', async () => {
    const calls = await run([
      chunk([{ index: 0, id: 'call_a', function: { name: 'f', arguments: '{"x":' } }]),
      chunk([{ index: 1, id: 'call_b', function: { name: 'g', arguments: '{}' } }]),
      chunk([{ index: 0, function: { arguments: '1}' } }]),
      chunk(null, 'tool_calls'),
    ]);
    expect(calls).toEqual([1]);
  });
  it('正常顺序 → 不调', async () => {
    const calls = await run([
      chunk([{ index: 0, id: 'call_a', function: { name: 'f', arguments: '{"x":1}' } }]),
      chunk([{ index: 1, id: 'call_b', function: { name: 'g', arguments: '{}' } }]),
      chunk(null, 'tool_calls'),
    ]);
    expect(calls).toEqual([]);
  });
});

describe('noteToolCallReopened', () => {
  it('按上游聚合（固定签名），会话与次数写进详情', () => {
    const rows = [];
    noteToolCallReopened({ wire: { upstreamId: 'zen', appModel: 'glm-5' }, sidShort: 'ab12', sessionTag: 'sess-1', n: 2, record: (r) => rows.push(r) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'auto', kind: 'bug', toolName: 'upstream:zen', signature: 'tool-call-reopened', sessionId: 'sess-1' });
    expect(rows[0].detail).toContain('ab12');
    expect(rows[0].detail).toContain('glm-5');
    expect(rows[0].detail).toContain('2 次');
  });
});
