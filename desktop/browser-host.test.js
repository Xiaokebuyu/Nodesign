// browser-host.cjs：视图关掉之后，之前排下的视口复查不能再碰它（09-17 站主桌面弹主进程未捕获异常）
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

class FakeWebContents extends EventEmitter {
  dead = false; zoom = 1; url = '';
  isDestroyed() { return this.dead; }
  setZoomFactor(z) { this.zoom = z; }
  getZoomFactor() { return this.zoom; }
  // 故意报一个跟 1366 对不上的宽度，让复查一路接着排下一次
  executeJavaScript() { return Promise.resolve({ w: 900, h: 506 }); }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  getURL() { return this.url; }
  setWindowOpenHandler() {}
  focus() {}
  close() { this.dead = true; this.emit('destroyed'); }
}
class FakeView {
  wc = new FakeWebContents();
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  // Electron 44.2.0 实测：close() 之后 view.webContents 是 undefined
  get webContents() { return this.wc.dead ? undefined : this.wc; }
  setBounds(b) { this.bounds = b; }
  getBounds() { return this.bounds; }
  setBackgroundColor() {}
}
const handlers = new Map();
const fakeElectron = {
  WebContentsView: FakeView,
  session: { fromPartition: () => ({ setProxy: async () => {} }) },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
};

let bridge;
beforeAll(async () => {
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron };
  const { createBrowserHost } = require('./browser-host.cjs');
  const host = createBrowserHost({ getWindow: () => null, log: () => {}, cdpPort: 9 });
  bridge = await host.start();
});
afterEach(() => { vi.useRealTimers(); });

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, bridge.bridgeUrl), {
      method, headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    }, (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve(JSON.parse(s || '{}'))); });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

describe('browser-host 视图关闭后的复查', () => {
  it('建完立刻关：300ms 后的复查不抛', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { viewId } = await call('POST', '/views', { projectId: 'p1' });
    expect((await call('DELETE', `/views/${viewId}`)).ok).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);   // 复查确实排着，不然这条测不到东西
    await vi.advanceTimersByTimeAsync(2000);         // 定时器里抛的异常会从这里冒出来
  });

  it('复查链跑到一半关：后面那几次也不抛', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { viewId } = await call('POST', '/views', { projectId: 'p2' });
    await vi.advanceTimersByTimeAsync(300);          // 第一次复查读到 900 ≠ 1366，接着排下一次
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await call('DELETE', `/views/${viewId}`);
    await vi.advanceTimersByTimeAsync(2000);         // 定时器里抛的异常会从这里冒出来
  });

  it('关掉之后 IPC 与诊断接口照常回答', async () => {
    const { viewId } = await call('POST', '/views', { projectId: 'p3' });
    await call('DELETE', `/views/${viewId}`);
    expect(await handlers.get('nd:browser-state')(null, 'p3')).toEqual({ live: false });
    expect(await handlers.get('nd:browser-focus')(null, 'p3')).toEqual({ ok: false });
    expect((await call('GET', '/views')).views.some((v) => v.projectId === 'p3')).toBe(false);
    expect(await call('GET', `/views/${viewId}`)).toEqual({ error: 'no such view' });
  });
});
