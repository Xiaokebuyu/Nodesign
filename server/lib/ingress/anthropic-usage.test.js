import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createAnthropicUsageScanner, tapAnthropicUsage } from './anthropic-usage.js';

const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

describe('createAnthropicUsageScanner：流式', () => {
  it('message_start 的 input 三项 + message_delta 的累计 output，后到覆盖先到', () => {
    const s = createAnthropicUsageScanner({ stream: true });
    s.feed(sse('message_start', { message: { usage: { input_tokens: 120, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40, output_tokens: 1 } } }));
    s.feed(sse('content_block_delta', { delta: { type: 'text_delta', text: '你好' } }));
    s.feed(sse('message_delta', { usage: { output_tokens: 57 } }));
    expect(s.finish()).toEqual({ input: 120, output: 57, cacheRead: 3000, cacheCreate: 40 });
  });
  it('分片切在一行中间也能拼回来', () => {
    const s = createAnthropicUsageScanner({ stream: true });
    const whole = sse('message_start', { message: { usage: { input_tokens: 9, output_tokens: 1 } } }) + sse('message_delta', { usage: { output_tokens: 22 } });
    for (let i = 0; i < whole.length; i += 7) s.feed(whole.slice(i, i + 7));
    expect(s.finish()).toEqual({ input: 9, output: 22, cacheRead: 0, cacheCreate: 0 });
  });
  it('没有任何 usage（错误流 / 空流）→ null，不编数', () => {
    const s = createAnthropicUsageScanner({ stream: true });
    s.feed('event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n');
    expect(s.finish()).toBeNull();
  });
  it('坏 JSON 行跳过不炸', () => {
    const s = createAnthropicUsageScanner({ stream: true });
    s.feed('data: {not json\n');
    s.feed(sse('message_delta', { usage: { output_tokens: 3 } }));
    expect(s.finish()).toEqual({ input: 0, output: 3, cacheRead: 0, cacheCreate: 0 });
  });
});

describe('createAnthropicUsageScanner：非流式', () => {
  it('从响应体顶层 usage 取', () => {
    const s = createAnthropicUsageScanner({ stream: false });
    const body = JSON.stringify({ id: 'msg', usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    s.feed(body.slice(0, 10)); s.feed(body.slice(10));
    expect(s.finish()).toEqual({ input: 5, output: 8, cacheRead: 0, cacheCreate: 0 });
  });
  it('响应体不是 JSON → null', () => {
    const s = createAnthropicUsageScanner({ stream: false });
    s.feed('<html>bad gateway</html>');
    expect(s.finish()).toBeNull();
  });
});

describe('tapAnthropicUsage：挂在真流上', () => {
  function fakeRes(status, contentType) {
    const pt = new PassThrough();
    pt.statusCode = status;
    pt.headers = { 'content-type': contentType };
    return pt;
  }
  it('2xx SSE：end 时回一次，且不影响下游 pipe 收到的字节', async () => {
    const res = fakeRes(200, 'text/event-stream');
    const sink = new PassThrough();
    const got = [];
    tapAnthropicUsage(res, { onUsage: (t) => got.push(t) });
    res.pipe(sink);
    const payload = sse('message_start', { message: { usage: { input_tokens: 11, output_tokens: 1 } } }) + sse('message_delta', { usage: { output_tokens: 4 } });
    res.end(payload);
    const out = await new Promise((r) => { const cs = []; sink.on('data', (c) => cs.push(c)); sink.on('end', () => r(Buffer.concat(cs).toString())); });
    expect(out).toBe(payload);
    expect(got).toEqual([{ input: 11, output: 4, cacheRead: 0, cacheCreate: 0 }]);
  });
  it('close 没有 end（被看门狗掐了）也结一次，且只结一次', async () => {
    const res = fakeRes(200, 'text/event-stream');
    const got = [];
    tapAnthropicUsage(res, { onUsage: (t) => got.push(t) });
    res.write(sse('message_start', { message: { usage: { input_tokens: 7, output_tokens: 1 } } }));
    res.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ input: 7, output: 1, cacheRead: 0, cacheCreate: 0 }]);
  });
  it('非 2xx 不旁听（错误响应没花钱）', async () => {
    const res = fakeRes(529, 'application/json');
    const got = [];
    tapAnthropicUsage(res, { onUsage: (t) => got.push(t) });
    res.end(JSON.stringify({ usage: { input_tokens: 999 } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([]);
  });
});
