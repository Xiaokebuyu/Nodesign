import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { registerIngressSession, unregisterIngressSession, switchSessionToStandby, resolveSessionWire, sessionMainModel } from './session-routes.js';
import { makeStandbySwitcher, PERMANENT } from './standby.js';
import { FailStreaks } from './upstream-fail-streak.js';
import { forwardOpenAIChat } from './forward-openai-chat.js';
import { standbyModelOf, SELECTABLE_MODELS } from '../../engine/agent/model-context.js';

describe('模型表 standby', () => {
  it('每条可选的 API 行都配了备用行，且备用行是另一条 API 行', () => {
    for (const m of SELECTABLE_MODELS) {
      const sb = standbyModelOf(m.id);
      if (!sb) continue;   // 订阅行没有 standby
      expect(sb).not.toBe(m.id);
    }
    expect(standbyModelOf('glm-5.3-flash-merge')).toBe('deepseek-v4-flash-vision');
    expect(standbyModelOf('deepseek-v4-flash-vision')).toBe('glm-5.3-flash-merge');
    expect(standbyModelOf('claude-opus-5[1m]')).toBeNull();
  });
});

describe('switchSessionToStandby：会话级换线', () => {
  it('换到备用行；CLI 仍按原行名字发也认成主行；一个会话只换一次', () => {
    registerIngressSession('sw1', 'glm-5.3-flash-merge');
    try {
      expect(resolveSessionWire('glm-5.3-flash-merge', 'sw1').wire.upstreamId).toBe('merge');
      expect(switchSessionToStandby('sw1')).toEqual({ from: 'glm-5.3-flash-merge', to: 'deepseek-v4-flash-vision' });
      const r = resolveSessionWire('glm-5.3-flash-merge', 'sw1');
      expect(r.role).toBe('main');
      expect(r.wire.appModel).toBe('deepseek-v4-flash-vision');
      expect(sessionMainModel('sw1')).toBe('deepseek-v4-flash-vision');
      expect(switchSessionToStandby('sw1')).toBeNull();   // 不来回跳
    } finally { unregisterIngressSession('sw1'); }
  });
  it('没注册的会话 / 没 standby 的行 → null', () => {
    expect(switchSessionToStandby('nope')).toBeNull();
    registerIngressSession('sw2', 'claude-opus-5[1m]');   // 订阅行不进 ingress 表
    expect(switchSessionToStandby('sw2')).toBeNull();
  });
});

describe('makeStandbySwitcher', () => {
  it('换线成功：清计数、通知用户；没得换返回 false 不通知', () => {
    registerIngressSession('sw3', 'glm-5.3-flash-merge');
    try {
      const fs = new FailStreaks(); const notices = []; const issues = [];
      fs.note('sw3:main', false, 'HTTP 503');
      const sw = makeStandbySwitcher({ sessionTag: 'sw3', sidShort: 'sw3', streakKey: 'sw3:main', failStreaks: fs, label: 'Merge', upstreamId: 'merge', noticeSession: (_s, n) => notices.push(n), record: (i) => issues.push(i) });
      expect(sw('HTTP 503')).toBe(true);
      // 告警进问题库：source=auto、按上游归工具名，不管换没换成都记
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ source: 'auto', toolName: 'upstream:merge', kind: 'bug' });
      expect(issues[0].summary).toContain('Merge');
      expect(fs.map.has('sw3:main')).toBe(false);
      expect(notices[0].key).toBe('upstream_standby');
      expect(notices[0].text).toContain('deepseek-v4-flash-vision');
      expect(sw('HTTP 503')).toBe(false);
      expect(issues).toHaveLength(2);   // 第二次没得换了，告警照记
    } finally { unregisterIngressSession('sw3'); }
  });
  it('PERMANENT 只有 401/402/403', () => { expect([...PERMANENT].sort()).toEqual([401, 402, 403]); });
  it('402 的告警正文点明是凭据或余额问题；默认 record 走真问题库且 fail-soft', () => {
    const issues = [];
    const sw = makeStandbySwitcher({ sessionTag: 'nope', sidShort: 'n', streakKey: 'n:main', failStreaks: new FailStreaks(), label: 'GMI', upstreamId: 'gmi', noticeSession: () => {}, record: (i) => issues.push(i) });
    expect(sw('HTTP 402')).toBe(false);
    expect(issues[0].detail).toContain('余额');
    const real = makeStandbySwitcher({ sessionTag: 'nope', sidShort: 'n', streakKey: 'n:main', failStreaks: new FailStreaks(), label: 'GMI', upstreamId: 'gmi', noticeSession: () => {} });
    expect(() => real('HTTP 402')).not.toThrow();
  });
});

function fakeUpstream(handler) {
  return new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })); });
}
function fakeRes() {
  const out = { status: null, headers: null, chunks: [] }; let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  const res = { headersSent: false, writeHead(s, h) { out.status = s; out.headers = h; res.headersSent = true; }, write(c) { out.chunks.push(String(c)); return true; }, end(c) { if (c) out.chunks.push(String(c)); resolveDone(); }, on() {}, once() {}, emit() {}, flushHeaders() {} };
  return { res, out, done };
}

describe('forwardOpenAIChat：onOutcome 返回状态码时改写给 CLI 的回应（换线 402 → 503）', () => {
  for (const stream of [false, true]) {
    it(`${stream ? '流式' : '非流式'}：上游 402 → onOutcome 收到 status=402、回 503 且文案带"已切换备用模型"`, async () => {
      const { srv, port } = await fakeUpstream((req, res) => { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end('{"error":"Insufficient balance"}'); });
      try {
        const calls = []; const { res, out, done } = fakeRes();
        forwardOpenAIChat({
          parsed: { model: 'm', stream, messages: [{ role: 'user', content: 'hi' }] },
          wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } },
          key: 'k', res, sidShort: 't', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false,
          onOutcome: (ok, reason, status) => { calls.push([ok, reason, status]); return status === 402 ? 503 : undefined; },
        });
        await done;
        expect(calls).toEqual([[false, 'HTTP 402', 402]]);
        expect(out.status).toBe(503);
        expect(out.chunks.join('')).toContain('已切换备用模型');
      } finally { srv.close(); }
    });
  }
  it('onOutcome 不返回 → 状态码原样', async () => {
    const { srv, port } = await fakeUpstream((req, res) => { res.writeHead(503); res.end(''); });
    try {
      const { res, out, done } = fakeRes();
      forwardOpenAIChat({ parsed: { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }, wire: { upstreamId: 'fake', wireModel: 'm', upstream: { label: 'Fake' } }, key: 'k', res, sidShort: 't', target: new URL(`http://127.0.0.1:${port}`), path: '/chat/completions', agent: false, onOutcome: () => undefined });
      await done;
      expect(out.status).toBe(503);
    } finally { srv.close(); }
  });
});
