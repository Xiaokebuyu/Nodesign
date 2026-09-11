// 首字节两道闸（2026-09-08 桌面端经 relay 吃 Cloudflare 524 之后加的）：
//   早提交：等 EARLY_COMMIT 没首字节 → 先写 200 + SSE 头并发 ping（CF 的 120 秒看的是响应头）
//   看门狗：等 FIRST_BYTE 没首字节 → 掐断这一发走既有重发判决
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { forwardOpenAIChat, earlyCommitMs, firstByteMs, DEFAULT_EARLY_COMMIT_MS, DEFAULT_FIRST_BYTE_MS } from './forward-openai-chat.js';

const ENV = ['NODESIGN_INGRESS_EARLY_COMMIT_MS', 'NODESIGN_INGRESS_FIRST_BYTE_MS', 'NODESIGN_INGRESS_EMPTY_RETRIES', 'NODESIGN_INGRESS_RETRY_BUDGET_MS'];
const saved = {};
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function fakeUpstream(handler) {
  return new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })); });
}
function fakeRes() {
  const out = { status: null, headers: null, chunks: [], headerAt: null }; let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  const res = { headersSent: false, writableEnded: false, writeHead(s, h) { out.status = s; out.headers = h; out.headerAt = Date.now(); res.headersSent = true; }, write(c) { out.chunks.push(String(c)); return true; }, end(c) { if (c) out.chunks.push(String(c)); res.writableEnded = true; resolveDone(); }, on() {}, once() {}, emit() {}, flushHeaders() {} };
  return { res, out, done };
}
function sseOk(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const call = (port, res, extra = {}) => forwardOpenAIChat({
  parsed: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } },
  key: 'k', res, sidShort: 't', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false, ...extra,
});

describe('阈值', () => {
  it('默认 60s / 90s，都 < Cloudflare 的 120s；环境变量可调，非法值落默认', () => {
    expect(DEFAULT_EARLY_COMMIT_MS).toBe(60_000);
    expect(DEFAULT_FIRST_BYTE_MS).toBe(90_000);
    expect(DEFAULT_EARLY_COMMIT_MS).toBeLessThan(120_000);
    expect(DEFAULT_FIRST_BYTE_MS).toBeLessThan(120_000);
    expect(earlyCommitMs({ NODESIGN_INGRESS_EARLY_COMMIT_MS: '250' })).toBe(250);
    expect(firstByteMs({ NODESIGN_INGRESS_FIRST_BYTE_MS: 'x' })).toBe(DEFAULT_FIRST_BYTE_MS);
  });
});

describe('上游一直不回首字节', () => {
  it('早提交：到点先写 200 + SSE 头并发 ping；看门狗到点掐断；额度用完以流内 error 收场', async () => {
    process.env.NODESIGN_INGRESS_EARLY_COMMIT_MS = '150';
    process.env.NODESIGN_INGRESS_FIRST_BYTE_MS = '400';
    process.env.NODESIGN_INGRESS_EMPTY_RETRIES = '0';
    const held = [];
    const { srv, port } = await fakeUpstream((req, res) => { held.push(res); });   // 永不回
    try {
      const { res, out, done } = fakeRes(); const outcomes = [];
      const t0 = Date.now();
      call(port, res, { onOutcome: (ok, reason) => { outcomes.push([ok, reason]); } });
      await done;
      const elapsed = Date.now() - t0;
      expect(out.status).toBe(200);
      expect(out.headers['Content-Type']).toContain('text/event-stream');
      expect(out.headerAt - t0).toBeGreaterThanOrEqual(140);   // 是等到早提交点才写的，不是一上来就写
      expect(out.headerAt - t0).toBeLessThan(400);              // 且在看门狗之前
      expect(elapsed).toBeGreaterThanOrEqual(390);
      expect(elapsed).toBeLessThan(3000);
      const body = out.chunks.join('');
      expect(body).toContain('event: error');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0][0]).toBe(false);
    } finally { for (const r of held) { try { r.destroy(); } catch { /* */ } } srv.close(); }
  });

  it('看门狗掐掉第一发后就地重发，第二发正常 → 用户拿到正文，只写过一次 200', async () => {
    process.env.NODESIGN_INGRESS_EARLY_COMMIT_MS = '150';
    // 看门狗给 1 秒（09-11 前是 300ms）：第二发要在看门狗内回首字节，全量并发跑时 300ms 偶尔不够，
    // 第二发也被掐 → 重试额度用完 → 断言拿不到正文（单跑 5/5 过、全量掉过一次）。这条测的是"掐了会重发"，不是看门狗多紧
    process.env.NODESIGN_INGRESS_FIRST_BYTE_MS = '1000';
    process.env.NODESIGN_INGRESS_EMPTY_RETRIES = '1';
    process.env.NODESIGN_INGRESS_RETRY_BUDGET_MS = '10000';
    let n = 0; const held = [];
    const { srv, port } = await fakeUpstream((req, res) => { n += 1; if (n === 1) { held.push(res); return; } sseOk(res, 'hello'); });
    try {
      const { res, out, done } = fakeRes(); const outcomes = []; const notices = [];
      let heads = 0; const origWriteHead = res.writeHead; res.writeHead = (...a) => { heads += 1; return origWriteHead(...a); };
      call(port, res, { onOutcome: (ok, reason) => { outcomes.push([ok, reason]); }, onNotice: (t) => notices.push(t) });
      await done;
      expect(n).toBe(2);
      expect(heads).toBe(1);
      expect(out.status).toBe(200);
      const body = out.chunks.join('');
      expect(body).toContain('hello');
      expect(body).toContain('message_stop');
      expect(body).not.toContain('event: error');
      expect(outcomes).toEqual([[true, '']]);
      expect(notices.join('')).toContain('原地重发');
    } finally { for (const r of held) { try { r.destroy(); } catch { /* */ } } srv.close(); }
  });

  it('首字节在早提交之后、看门狗之前到达 → 正常流，不掐', async () => {
    process.env.NODESIGN_INGRESS_EARLY_COMMIT_MS = '100';
    process.env.NODESIGN_INGRESS_FIRST_BYTE_MS = '1500';
    process.env.NODESIGN_INGRESS_EMPTY_RETRIES = '0';
    let n = 0;
    const { srv, port } = await fakeUpstream((req, res) => { n += 1; setTimeout(() => sseOk(res, 'late'), 300); });
    try {
      const { res, out, done } = fakeRes();
      call(port, res);
      await done;
      expect(n).toBe(1);
      expect(out.status).toBe(200);
      const body = out.chunks.join('');
      expect(body).toContain('event: ping');   // 早提交后等首字节期间在保活
      expect(body).toContain('late');
      expect(body).not.toContain('event: error');
    } finally { srv.close(); }
  });

  it('上游秒回 → 两个定时器不触发，行为与从前一致（不早提交、没有 ping）', async () => {
    process.env.NODESIGN_INGRESS_EARLY_COMMIT_MS = '500';
    process.env.NODESIGN_INGRESS_FIRST_BYTE_MS = '800';
    const { srv, port } = await fakeUpstream((req, res) => sseOk(res, 'fast'));
    try {
      const { res, out, done } = fakeRes(); const t0 = Date.now();
      call(port, res);
      await done;
      expect(Date.now() - t0).toBeLessThan(400);
      expect(out.chunks.join('')).toContain('fast');
      expect(out.chunks.join('')).not.toContain('event: ping');
    } finally { srv.close(); }
  });
});
