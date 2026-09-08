// 环形账（upstream-health）从转发层拿到的账要对（09-08 评审三条）：
//   ① 客户端主动断开不进账；② 非流式也进账；③ ms 是首字节不是整发
import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import { forwardOpenAIChat } from './forward-openai-chat.js';
import { upstreamHealth } from './upstream-health.js';

function fakeUpstream(handler) { return new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port })); }); }
function fakeRes() {
  const out = { status: null, chunks: [] }; let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  const handlers = {};
  const res = { headersSent: false, writableEnded: false, writeHead(s) { out.status = s; res.headersSent = true; }, write(c) { out.chunks.push(String(c)); return true; }, end(c) { if (c) out.chunks.push(String(c)); res.writableEnded = true; resolveDone(); }, on(ev, fn) { handlers[ev] = fn; }, once() {}, emit(ev) { handlers[ev]?.(); }, flushHeaders() {} };
  return { res, out, done, handlers };
}
function sseOk(res, text, delayMs = 0) {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();   // Node 不 flush 头就跟第一段正文一起走
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
    }, 250);   // 头先到、正文 250ms 后才到：ms 要接近 delayMs 而不是 delayMs+250
  }, delayMs);
}
const wire = { upstreamId: 'fake-health', wireModel: 'm', upstream: { label: 'Fake' } };
const call = (port, res, stream, extra = {}) => forwardOpenAIChat({ parsed: { model: 'm', stream, messages: [{ role: 'user', content: 'hi' }] }, wire, key: 'k', res, sidShort: 't', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false, ...extra });
const ring = () => upstreamHealth.rings.get('fake-health') || [];
beforeEach(() => upstreamHealth.rings.delete('fake-health'));

describe('转发层喂环形账', () => {
  it('流式成功进账一条 ok，ms 是首字节（不含正文流的 250ms）', async () => {
    const { s, port } = await fakeUpstream((req, res) => sseOk(res, 'hi', 100));
    try { const { res, done } = fakeRes(); call(port, res, true); await done; } finally { s.close(); }
    expect(ring()).toHaveLength(1);
    expect(ring()[0].ok).toBe(true);
    expect(ring()[0].ms).toBeGreaterThanOrEqual(80);
    expect(ring()[0].ms).toBeLessThan(300);
  });
  it('⛔ 客户端在等首字节时断开：onOutcome 照报，环形账不记', async () => {
    const held = [];
    const { s, port } = await fakeUpstream((req, res) => held.push(res));
    try {
      const { res, handlers } = fakeRes(); const outcomes = [];
      call(port, res, true, { onOutcome: (ok, reason) => { outcomes.push([ok, reason]); } });
      await new Promise((r) => setTimeout(r, 120));
      handlers.close();   // 用户点了停止
      expect(outcomes).toEqual([[false, 'client disconnected']]);
      expect(ring()).toHaveLength(0);
    } finally { for (const r of held) { try { r.destroy(); } catch { /* */ } } s.close(); }
  });
  it('非流式：成功与 4xx 都进账；连不上也进账（ms=null）', async () => {
    let n = 0;
    const { s, port } = await fakeUpstream((req, res) => { n += 1; if (n === 1) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); } else { res.writeHead(429); res.end('{"error":"slow down"}'); } });
    try {
      for (let i = 0; i < 2; i++) { const { res, done } = fakeRes(); call(port, res, false); await done; }
    } finally { s.close(); }
    const { res, done } = fakeRes(); call(9, res, false); await done;   // 端口 9：连不上
    expect(ring().map((e) => [e.ok, e.status])).toEqual([[true, null], [false, 429], [false, null]]);
    expect(ring()[2].ms).toBeNull();
    expect(ring()[2].reason).toContain('forward:');
  });
});
