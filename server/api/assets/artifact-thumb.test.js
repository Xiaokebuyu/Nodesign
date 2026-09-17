/**
 * `GET /:pid/artifact-thumb` 的 HTTP 层（09-17，问题库 iss_mu0v5pa5_3ojg）。
 * 生成与缓存在 lib/artifact-thumb.test.js；这里钉缓存头、状态码、鉴权先行、断开连接的通知。
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { makeArtifactThumbHandler } from './artifact-thumb.js';

function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    headers: {}, code: 200, body: undefined, ended: false, writableFinished: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.code = c; return this; },
    type(t) { this.headers['content-type'] = t; return this; },
    json(b) { this.body = b; this.ended = true; this.writableFinished = true; return this; },
    send(b) { this.body = b; this.ended = true; this.writableFinished = true; return this; },
    end() { this.ended = true; this.writableFinished = true; return this; },
  });
  return res;
}
const req = (over = {}) => ({
  params: { pid: 'p1' }, query: { path: '站/index.html', kind: 'site', v: '3' }, headers: {}, ...over,
});

function mount(result, { guard = true } = {}) {
  const calls = [];
  const thumbs = { get: vi.fn(async (a) => { calls.push(a); return typeof result === 'function' ? result(a) : result; }) };
  const handler = makeArtifactThumbHandler({
    getSharedDir: (pid) => `/ws/${pid}`,
    guardProject: (rq, rs) => { if (!guard) { rs.status(404).json({ error: 'no' }); } return guard; },
    thumbs,
  });
  return { handler, thumbs, calls };
}

describe('artifact-thumb 路由', () => {
  it('⭐ 200：webp + ETag + private max-age=60；入参原样交给服务层（v 不传下去）', async () => {
    const { handler, calls } = mount({ status: 200, etag: 'abc', buffer: Buffer.from('img') });
    const res = fakeRes();
    await handler(req({ headers: { 'if-none-match': '"old"' } }), res, (e) => { throw e; });
    expect(res.code).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(String(res.body)).toBe('img');
    expect(calls[0]).toMatchObject({ pid: 'p1', sharedDir: '/ws/p1', relPath: '站/index.html', kind: 'site', ifNoneMatch: '"old"' });
    expect(calls[0]).not.toHaveProperty('v');
  });

  it('304：带 ETag 与同一缓存头，无正文', async () => {
    const { handler } = mount({ status: 304, etag: 'abc' });
    const res = fakeRes();
    await handler(req(), res, (e) => { throw e; });
    expect(res.code).toBe(304);
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(res.body).toBeUndefined();
  });

  it('⭐ 204 / 4xx：保持 no-store（CF 边缘缓存错误响应那条规矩）', async () => {
    for (const out of [{ status: 204, reason: 'failed' }, { status: 400, error: 'kind' }, { status: 403, error: 'x' }, { status: 404, error: 'y' }]) {
      const { handler } = mount(out);
      const res = fakeRes();
      await handler(req(), res, (e) => { throw e; });
      expect(res.code).toBe(out.status);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.etag).toBeUndefined();
    }
  });

  it('⭐ 鉴权不过：不碰服务层，且 no-store 已先设上', async () => {
    const { handler, thumbs } = mount({ status: 200, etag: 'a', buffer: Buffer.from('') }, { guard: false });
    const res = fakeRes();
    await handler(req(), res, (e) => { throw e; });
    expect(thumbs.get).not.toHaveBeenCalled();
    expect(res.code).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('⭐ 客户端先断开 → isGone() 为真；正常发完的不算断开', async () => {
    let seen;
    const res = fakeRes();
    const { handler } = mount(async (a) => {
      res.emit('close');            // 排队中浏览器掐掉了请求
      seen = a.isGone();
      return { status: 204, reason: 'gone' };
    });
    await handler(req(), res, (e) => { throw e; });
    expect(seen).toBe(true);

    let later;
    const res2 = fakeRes();
    const { handler: h2 } = mount(async (a) => { later = a.isGone; return { status: 200, etag: 'e', buffer: Buffer.from('x') }; });
    await h2(req(), res2, (e) => { throw e; });
    res2.emit('close');             // 发完之后连接照常关闭
    expect(later()).toBe(false);
  });

  it('kind 缺省传空串（由服务层判 400），不是 undefined', async () => {
    const { handler, calls } = mount({ status: 400, error: 'kind' });
    await handler(req({ query: { path: 'a.html' } }), fakeRes(), (e) => { throw e; });
    expect(calls[0].kind).toBe('');
  });

  it('服务层抛错交给 next', async () => {
    const boom = new Error('boom');
    const { handler } = mount(() => { throw boom; });
    const next = vi.fn();
    await handler(req(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
