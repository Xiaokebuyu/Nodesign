import { describe, it, expect, vi } from 'vitest';
import { registerInflight, inflightTurns, INFLIGHT_RETENTION_MS } from './turn-inflight.js';

const fakeRes = () => { const res = { ended: 0 }; res.end = function end() { this.ended += 1; return this; }; return res; };

describe('registerInflight（09-13 fable 审查第三轮 P1-1）', () => {
  it('⭐ 登记后早退（没 resolve 就结束响应）→ 等待中的重发拿到 reject、条目清掉，不挂死', async () => {
    const res = fakeRes();
    registerInflight('req-early', res);
    const waiting = inflightTurns.get('req-early');
    res.end();   // 404 / 409 / 429 这类早退最终都走 res.end
    await expect(waiting).rejects.toThrow('turn ended without a run');
    expect(inflightTurns.has('req-early')).toBe(false);
    expect(res.ended).toBe(1);   // 原 end 照常调用
  });

  it('正常路径先 resolve 再回 202：结束响应不再 reject；条目 5 秒后清', async () => {
    vi.useFakeTimers();
    try {
      const res = fakeRes();
      const { resolve } = registerInflight('req-ok', res);
      const waiting = inflightTurns.get('req-ok');
      resolve({ pid: 'p', runId: 'r1', sessionId: 's' });
      res.end();
      await expect(waiting).resolves.toMatchObject({ runId: 'r1' });
      expect(inflightTurns.has('req-ok')).toBe(true);
      vi.advanceTimersByTime(INFLIGHT_RETENTION_MS + 1);
      expect(inflightTurns.has('req-ok')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('catch 路径 reject 后再结束响应只 settle 一次；清条目不误删同 requestId 的新登记', async () => {
    const res1 = fakeRes();
    const first = registerInflight('req-x', res1);
    const p1 = inflightTurns.get('req-x');
    first.reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    const res2 = fakeRes();
    registerInflight('req-x', res2);
    const p2 = inflightTurns.get('req-x');
    res1.end();   // 第一发的响应这时才结束
    expect(inflightTurns.get('req-x')).toBe(p2);
  });
});
