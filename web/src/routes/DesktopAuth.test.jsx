// @vitest-environment happy-dom
// 桌面版登录确认页（09-13 auth-v2 第四批）：参数校验与服务端同口径；「允许」发 JSON POST 并只跳 127.0.0.1；
// 被嵌进框架时一个按钮都不画；「取消」通知本机回调。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../components/layout/AppShell.jsx', () => ({ default: ({ children }) => children }));
vi.mock('./desk.jsx', () => ({ Desk: ({ children }) => children }));

const { default: DesktopAuth, parseDesktopAuthQuery } = await import('./DesktopAuth.jsx');
const { useGlobalStore } = await import('../stores/globalStore.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const CHALLENGE = 'c'.repeat(43);
const GOOD = `?port=45678&state=abcdefghijklmnopqrst&challenge=${CHALLENGE}&device=LAPTOP-01`;

describe('parseDesktopAuthQuery', () => {
  it('合规参数通过；端口、state、challenge 不合规一律 null', () => {
    expect(parseDesktopAuthQuery(GOOD)).toEqual({ port: 45678, state: 'abcdefghijklmnopqrst', challenge: CHALLENGE, device: 'LAPTOP-01' });
    for (const bad of [
      GOOD.replace('45678', '80'), GOOD.replace('45678', '4001@evil.example'), GOOD.replace('45678', '99999'),
      GOOD.replace('abcdefghijklmnopqrst', 'short'), GOOD.replace(CHALLENGE, 'abc'), '',
    ]) expect(parseDesktopAuthQuery(bad), bad).toBeNull();
  });
  it('设备名去控制字符、截断', () => {
    const p = parseDesktopAuthQuery(`${GOOD.replace('LAPTOP-01', '')}${encodeURIComponent('PC\u0000\n' + 'x'.repeat(90))}`);
    expect(p.device.startsWith('PC')).toBe(true);
    expect(p.device).not.toMatch(/[\u0000\n]/);
    expect(p.device.length).toBe(60);
  });
});

describe('DesktopAuth', () => {
  let host; let root; let assign;
  const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
  const click = async (text) => {
    const b = [...host.querySelectorAll('button')].find((x) => x.textContent === text);
    await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await flush();
  };
  const mount = async (search = GOOD) => {
    vi.stubGlobal('location', { pathname: '/desktop-auth', search, assign, reload: vi.fn() });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<DesktopAuth />); });
    await flush();
  };
  beforeEach(() => {
    useGlobalStore.getState().setAuthUser({ id: 'u1', username: 'alice', email: 'a@example.com' });
    assign = vi.fn();
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
  });

  it('展示账号、设备名、端口；「允许」发 JSON POST，跳服务端给的本机地址', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, redirect: 'http://127.0.0.1:45678/api/local/relay/callback?code=k&state=s' }) }));
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    expect(host.textContent).toContain('alice（a@example.com）');
    expect(host.textContent).toContain('LAPTOP-01');
    expect(host.textContent).toContain('45678');
    await click('允许');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/me/desktop-auth/authorize');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({ port: 45678, state: 'abcdefghijklmnopqrst', challenge: CHALLENGE });
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:45678/api/local/relay/callback?code=k&state=s');
  });

  it('服务端回的跳转地址不是 127.0.0.1：不跳，显示错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ redirect: 'https://evil.example/cb' }) })));
    await mount();
    await click('允许');
    expect(assign).not.toHaveBeenCalled();
    expect(buttons()).toContain('允许');
  });

  it('「取消」跳本机回调带 error=access_denied 与 state', async () => {
    await mount();
    await click('取消');
    expect(assign.mock.calls[0][0]).toBe('http://127.0.0.1:45678/api/local/relay/callback?error=access_denied&state=abcdefghijklmnopqrst');
  });

  it('链接无效：不画按钮', async () => {
    await mount('?port=80');
    expect(buttons()).toEqual([]);
    expect(host.textContent).toContain('登录链接无效');
  });

  it('被嵌进框架：不画按钮', async () => {
    const top = Object.getOwnPropertyDescriptor(window, 'top');
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) });
    try {
      await mount();
      expect(buttons()).toEqual([]);
      expect(host.textContent).toContain('不能在其他网页中打开');
    } finally {
      if (top) Object.defineProperty(window, 'top', top);
    }
  });
});
