// @vitest-environment happy-dom
// 「账号与安全」冒烟：真渲一遍、点两下 —— emailAuth 关时邮箱入口不露、会话列表、
// 退出其他设备遇到 REAUTH_REQUIRED 时展开验证身份并在验证后自动重跑、关联回跳的提示与查询串清理。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import AccountSecurity from './AccountSecurity.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function fakeServer({ emailAuth = false, hasPassword = true } = {}) {
  const calls = [];
  let recent = false;
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    if (url === '/api/auth/methods') return reply(200, { providers: ['google', 'github'], emailAuth, openRegistration: false });
    if (url === '/api/me/account') {
      return reply(200, {
        user: { id: 'u1', username: 'alice', role: 'user', locale: null, email: null, hasPassword }, emailVerifiedAt: null,
        recentAuth: recent, sessionId: 's1', identities: [{ provider: 'github', email: 'a@example.com', createdAt: 1 }],
      });
    }
    if (url === '/api/me/account/sessions') {
      return reply(200, { sessions: [
        { id: 's1', current: true, method: 'password', ip: '203.0.113.5', userAgent: CHROME_WIN, createdAt: Date.now(), lastSeenAt: Date.now() },
        { id: 's2', current: false, method: 'google', ip: '198.51.100.7', userAgent: '', createdAt: Date.now(), lastSeenAt: Date.now() - 7200_000 },
      ] });
    }
    if (url === '/api/me/account/sessions/revoke-others') {
      return recent ? reply(200, { ok: true, sessionsRevoked: 1, devicesRevoked: 2 }) : reply(403, { error: '请先验证身份', code: 'REAUTH_REQUIRED' });
    }
    if (url === '/api/me/account/reauth') {
      if (JSON.parse(init.body).password !== 'pw') return reply(401, { error: '密码不对', code: 'BAD_PASSWORD' });
      recent = true;
      return reply(200, { ok: true });
    }
    return reply(404, { error: 'not found' });
  });
  return { fetchImpl, calls };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (host, text) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
async function click(el) { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await flush(); }
async function type(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('AccountSecurity', () => {
  let host; let root; let server; let showToast;
  const mount = async (opts) => {
    server = fakeServer(opts);
    vi.stubGlobal('fetch', server.fetchImpl);
    showToast = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<AccountSecurity showToast={showToast} />); });
    await flush();
  };
  beforeEach(() => { window.history.replaceState(null, '', '/settings'); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it('emailAuth 关：邮箱只给说明不给入口；第三方与会话列表都在', async () => {
    await mount({ emailAuth: false });
    const text = host.textContent;
    expect(text).toContain('alice');
    expect(text).toContain('邮箱绑定将在稍后开放');
    expect(button(host, '绑定')).toBeUndefined();
    expect(text).toContain('已关联：a@example.com');
    expect(button(host, '解除关联')).toBeTruthy();
    expect(button(host, '关联')).toBeTruthy();   // google 没关联
    expect(text).toContain('Chrome · Windows');
    expect(text).toContain('当前');
    expect(text).toContain('未知设备');
  });

  it('emailAuth 开且没绑邮箱：出现「绑定」', async () => {
    await mount({ emailAuth: true });
    expect(button(host, '绑定')).toBeTruthy();
    expect(host.textContent).toContain('绑定邮箱后可以用邮箱登录，并在忘记密码时自助找回');
  });

  it('退出其他设备：确认 → 要求验证身份 → 输密码 → 自动重跑', async () => {
    await mount();
    await click(button(host, '退出其他所有设备（含桌面版）'));
    await click(button(host, '确认退出'));
    expect(host.textContent).toContain('验证身份');
    const pw = host.querySelector('input[type="password"]');
    await type(pw, 'wrong');
    await click(button(host, '验证'));
    expect(host.textContent).toContain('密码不对');
    await type(pw, 'pw');
    await click(button(host, '验证'));
    expect(server.calls.filter((c) => c === 'POST /api/me/account/sessions/revoke-others')).toHaveLength(2);
    expect(showToast).toHaveBeenCalledWith('已退出 1 处网页登录与 2 台桌面版设备', 'info');
    expect(host.textContent).not.toContain('此操作涉及账号安全');
  });

  it('关联回跳：提示一次并把参数从地址栏去掉', async () => {
    window.history.replaceState(null, '', '/settings?oauth_error=identity_taken#account');
    await mount();
    expect(showToast).toHaveBeenCalledWith('该第三方账号已关联到其他账号', 'error');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#account');
  });
});
