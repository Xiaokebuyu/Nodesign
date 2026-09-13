// @vitest-environment happy-dom
// 桌面版首启门（09-13 auth-v2 第四批）：「在浏览器中登录」发起 → 交给系统浏览器 → 轮询到 done 后回调、把窗口带到前面；
// 上一次回调没换成时继续等并说明原因；取消会通知本地服务端；账号密码是备选；令牌被站点判失效时开门先说明。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import DesktopLoginCard from './DesktopLoginCard.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

describe('DesktopLoginCard', () => {
  let host; let root; let calls; let statuses; let onDone; let bridge;
  const button = (text) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  const link = (text) => [...host.querySelectorAll('a')].find((a) => a.textContent === text);
  const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); };
  const submit = async () => { await act(async () => { host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); await flush(); };

  const mount = async (desktop = { loggedIn: false, url: 'https://nodesign.example' }) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<DesktopLoginCard className="ndw-card" desktop={desktop} onDone={onDone} />); });
    await flush();
  };

  beforeEach(() => {
    calls = [];
    statuses = [];
    onDone = vi.fn();
    bridge = { openExternal: vi.fn(async () => true), focusWindow: vi.fn(async () => true) };
    window.nodesignDesktop = bridge;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      if (url === '/api/local/relay/browser-login' && method === 'POST') return reply(201, { state: 'st1', authorizeUrl: 'https://nodesign.example/desktop-auth?port=4001&state=st1' });
      if (url === '/api/local/relay/browser-login/st1' && method === 'GET') return reply(200, statuses.shift() || { status: 'pending', error: null });
      if (url === '/api/local/relay/browser-login/st1' && method === 'DELETE') return reply(200, { ok: true });
      if (url === '/api/local/relay/login') return reply(401, { error: '账号或密码错误' });
      return reply(404, {});
    }));
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    delete window.nodesignDesktop;
    vi.unstubAllGlobals();
  });

  it('在浏览器中登录：交给系统浏览器，等待中显示上一次失败的原因，done 后回调并把窗口带到前面', async () => {
    await mount();
    await submit();
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/local/relay/browser-login' });
    expect(bridge.openExternal).toHaveBeenCalledWith('https://nodesign.example/desktop-auth?port=4001&state=st1');
    expect(host.textContent).toContain('在浏览器中完成登录');

    statuses.push({ status: 'pending', error: '授权已失效' });
    await wait(1300);
    expect(host.textContent).toContain('上一次尝试没有完成：授权已失效');
    expect(onDone).not.toHaveBeenCalled();

    statuses.push({ status: 'done', error: null });
    await wait(1300);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(bridge.focusWindow).toHaveBeenCalled();
  });

  it('等待中点「重新打开浏览器」再开同一个地址；「取消」通知本地服务端并回到初始', async () => {
    await mount();
    await submit();
    await click(button('重新打开浏览器'));
    expect(bridge.openExternal).toHaveBeenCalledTimes(2);
    await click(link('取消'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/local/relay/browser-login/st1')).toBe(true);
    expect(button('在浏览器中登录')).toBeTruthy();
  });

  it('令牌被站点判失效：开门先说明原因', async () => {
    await mount({ loggedIn: false, expired: true, url: 'https://nodesign.example', error: 'DEVICE_TOKEN_INVALID: 设备令牌无效或已吊销。' });
    expect(host.textContent).toContain('这台设备的登录已失效');
    // 失效不是「连不上站点」，别把两句话叠在一起
    expect(host.textContent).not.toContain('连不上站点');
  });

  it('账号密码是备选：切过去提交走 /api/local/relay/login，错误原样显示', async () => {
    await mount();
    await click(link('使用账号密码登录'));
    const [id, pw] = host.querySelectorAll('input');
    await act(async () => {
      for (const [input, value] of [[id, 'a@example.com'], [pw, 'wrong-pass']]) {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      }
    });
    await submit();
    expect(calls.at(-1)).toMatchObject({ url: '/api/local/relay/login', body: { username: 'a@example.com', password: 'wrong-pass' } });
    expect(host.textContent).toContain('账号或密码错误');
    expect(onDone).not.toHaveBeenCalled();
  });
});
