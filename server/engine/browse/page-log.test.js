import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachPageLog, readPageLog, notePageError, _resetPageLogs } from './page-log.js';

beforeEach(() => _resetPageLogs());
function fakePage() { const p = new EventEmitter(); return p; }

describe('浏览器页面日志', () => {
  it('console 只记 warn/error；pageerror / requestfailed / >=400 响应进账；lastError 指最近一次 error；同页只挂一次', () => {
    const page = fakePage();
    attachPageLog('p1', page); attachPageLog('p1', page);
    expect(page.listenerCount('console')).toBe(1);
    page.emit('console', { type: () => 'log', text: () => 'hello' });
    page.emit('console', { type: () => 'warning', text: () => 'deprecated' });
    page.emit('console', { type: () => 'error', text: () => 'Uncaught TypeError' });
    page.emit('pageerror', new Error('boom'));
    page.emit('requestfailed', { method: () => 'GET', url: () => 'https://www.andidea.jp/', failure: () => ({ errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }) });
    page.emit('response', { status: () => 404, url: () => 'https://x/a.png' });
    page.emit('response', { status: () => 200, url: () => 'https://x/ok' });
    const all = readPageLog('p1');
    expect(all.attached).toBe(true);
    expect(all.items.map((i) => i.kind)).toEqual(['console', 'console', 'pageerror', 'requestfailed', 'response']);
    expect(all.lastError.kind).toBe('requestfailed');
    expect(all.lastError.text).toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(readPageLog('p1', { level: 'error' }).items).toHaveLength(3);
    notePageError('p1', '网络闸拒了 198.18.1.236');
    expect(readPageLog('p1').lastError.kind).toBe('guard');
    expect(readPageLog('nope')).toEqual({ attached: false, items: [], lastError: null });
  });
});
