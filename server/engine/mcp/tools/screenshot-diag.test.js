/**
 * screenshot 诊断层与等待语义钉子（2026-08-19，agent 上报三案）：
 * - console.log 默认被滤但条数必须可见（iss_msz24e0q_vfwf：被静默吞掉，
 *   agent 以为代码没执行到，白改两轮）
 * - console:'all' 才回传 log 级，单独一桶不挤真错误
 * - waitFor 超时不挡截图，note 说清没等到
 */
import { describe, it, expect } from 'vitest';
import { attachPageDiagnostics, runWaitFor, mimeMismatch } from './helpers/shot-pipeline.js';

function fakePage() {
  const handlers = {};
  return {
    handlers,
    on(evt, cb) { handlers[evt] = cb; },
    off(evt, cb) { if (handlers[evt] === cb) delete handlers[evt]; },
    emitConsole(type, text) { handlers.console?.({ type: () => type, text: () => text }); },
    emitResponse({ url, status = 200, type, ct }) {
      handlers.response?.({
        url: () => url, status: () => status,
        headers: () => (ct == null ? {} : { 'content-type': ct }),
        request: () => ({ method: () => 'GET', resourceType: () => type }),
      });
    },
  };
}

describe('attachPageDiagnostics console 档位', () => {
  it("默认 'warn'：log 被滤但报条数 —— 没显示≠没发生", () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page);
    page.emitConsole('log', '[char] 可用动作: idle,run');
    page.emitConsole('log', 'boot ok');
    const s = diag.summary();
    expect(s).toContain('console clean');
    expect(s).toContain('2 log-level line(s) filtered');
    expect(s).toContain("console:'all'");
    expect(s).not.toContain('boot ok');
  });

  it("'all'：log 进自己那桶（分组计数），错误照旧在前", () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page, { console: 'all' });
    page.emitConsole('error', 'WebGL stall');
    page.emitConsole('log', 'tick 1');
    page.emitConsole('log', 'tick 1');
    const s = diag.summary();
    expect(s.indexOf('WebGL stall')).toBeLessThan(s.indexOf('tick 1'));
    expect(s).toContain('(×2 similar)');
    expect(s).not.toContain('filtered');
  });

  it('全干净且没滤任何东西 → 原样正向确认', () => {
    const diag = attachPageDiagnostics(fakePage());
    expect(diag.summary()).toBe('console clean, all requests OK');
  });
});

describe('runWaitFor', () => {
  it('条件为真 → null（caption 不加噪音）', async () => {
    expect(await runWaitFor({ waitForFunction: async () => {} }, 'window.__game')).toBeNull();
  });
  it('超时 → note 讲清没等到 + 照样截了', async () => {
    const page = { waitForFunction: async () => { throw new Error('Timeout 15000ms exceeded'); } };
    const note = await runWaitFor(page, 'window.__game');
    expect(note).toContain('not truthy within 15s');
    expect(note).toContain('captured anyway');
  });
  it('表达式抛错 → 也带回 note 而不是炸截图', async () => {
    const page = { waitForFunction: async () => { throw new Error('ReferenceError: x'); } };
    expect(await runWaitFor(page, 'x.y')).toContain('waitFor error');
  });
});

/**
 * 子资源 content-type 核对（09-17，iss_mt886uc1_7rne）：vite 产物 base 没设成 './' 时，
 * /assets/x.js 落到回退页上回 200 + text/html，只看 status<400 的旧判据报 all requests OK。
 */
describe('mimeMismatch：只抓明显不对的组合', () => {
  it.each([
    ['script', 'text/html; charset=utf-8', 200, 'text/html'],
    ['stylesheet', 'text/html', 200, 'text/html'],
    ['stylesheet', 'text/plain', 200, 'text/plain'],
    ['font', 'text/html', 200, 'text/html'],
    ['image', 'application/json', 200, 'application/json'],
  ])('%s + %s → 报 %s', (type, ct, status, want) => {
    expect(mimeMismatch(type, ct, status, 'http://127.0.0.1:4001/x')).toBe(want);
  });
  it.each([
    ['script', 'application/javascript', 200],
    ['script', 'text/javascript; charset=utf-8', 200],
    ['stylesheet', 'text/css; charset=utf-8', 200],
    ['font', 'font/woff2', 200],
    ['font', 'application/octet-stream', 200],
    ['image', 'image/svg+xml', 200],
    ['script', 'text/html', 304],          // 缓存命中不核
    ['script', '', 200],                    // 没给 content-type：浏览器嗅探，不算
    ['xhr', 'text/html', 200],              // fetch/XHR 拿 HTML 可能是正当的
    ['document', 'text/html', 200],
  ])('%s + %s（%s）→ 不报', (type, ct, status) => {
    expect(mimeMismatch(type, ct, status, 'https://cdn.example.com/x')).toBeNull();
  });
  it('data: / blob: 不核', () => {
    expect(mimeMismatch('image', 'text/html', 200, 'data:text/html,hi')).toBeNull();
  });
});

describe('attachPageDiagnostics：content-type 不对的逐条列出', () => {
  it('200 + text/html 的脚本与样式表各列一条，且不再报 all requests OK', () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page);
    page.emitResponse({ url: 'http://127.0.0.1:4001/assets/index-a.js', type: 'script', ct: 'text/html' });
    page.emitResponse({ url: 'http://127.0.0.1:4001/assets/index-b.css', type: 'stylesheet', ct: 'text/html' });
    page.emitResponse({ url: 'http://127.0.0.1:4001/assets/ok.js', type: 'script', ct: 'application/javascript' });
    const s = diag.summary();
    expect(s).not.toContain('all requests OK');
    expect(s).toContain('wrong content-type (2)');
    expect(s).toContain('GET http://127.0.0.1:4001/assets/index-a.js → 200 text/html (expected script)');
    expect(s).toContain('GET http://127.0.0.1:4001/assets/index-b.css → 200 text/html (expected stylesheet)');
    expect(s).not.toContain('ok.js');
  });
  it('≥400 仍走失败请求那一组', () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page);
    page.emitResponse({ url: 'http://127.0.0.1:4001/assets/gone.js', status: 404, type: 'script', ct: 'text/html' });
    const s = diag.summary();
    expect(s).toContain('HTTP 404');
    expect(s).not.toContain('wrong content-type');
  });
  it('detach 摘掉全部监听', () => {
    const page = fakePage();
    const diag = attachPageDiagnostics(page);
    expect(Object.keys(page.handlers).sort()).toEqual(['console', 'pageerror', 'requestfailed', 'response']);
    diag.detach();
    expect(Object.keys(page.handlers)).toEqual([]);
  });
});
