// 「账号与安全」纯函数：UA 摘要、关联回跳查询串、错误码文案、时间、请求出错的形状
import { describe, it, expect } from 'vitest';
import {
  summarizeUserAgent, readOAuthReturn, oauthErrorMessage, formatLastSeen, apiJson,
  linkStartUrl, providerLabel, sessionMethodLabel, isReauthError,
} from './account-api.js';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIpad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  operaMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0',
};

describe('summarizeUserAgent', () => {
  it('认主流浏览器与系统，Edge / Opera 不被当成 Chrome，iPad / 安卓不被当成 macOS / Linux', () => {
    expect(summarizeUserAgent(UA.chromeWin)).toBe('Chrome · Windows');
    expect(summarizeUserAgent(UA.edgeWin)).toBe('Edge · Windows');
    expect(summarizeUserAgent(UA.safariMac)).toBe('Safari · macOS');
    expect(summarizeUserAgent(UA.safariIphone)).toBe('Safari · iOS');
    expect(summarizeUserAgent(UA.chromeIpad)).toBe('Chrome · iPadOS');
    expect(summarizeUserAgent(UA.chromeAndroid)).toBe('Chrome · Android');
    expect(summarizeUserAgent(UA.firefoxLinux)).toBe('Firefox · Linux');
    expect(summarizeUserAgent(UA.operaMac)).toBe('Opera · macOS');
  });
  it('认不出返回空串（界面写「未知设备」）', () => {
    expect(summarizeUserAgent('')).toBe('');
    expect(summarizeUserAgent(null)).toBe('');
    expect(summarizeUserAgent('curl/8.5.0')).toBe('');
  });
});

describe('readOAuthReturn', () => {
  it('取出 linked / oauth_error，并保留其他参数', () => {
    expect(readOAuthReturn('?linked=google')).toEqual({ linked: 'google', error: null, search: '' });
    expect(readOAuthReturn('?oauth_error=identity_taken&tab=x')).toEqual({ linked: null, error: 'identity_taken', search: '?tab=x' });
    expect(readOAuthReturn('?a=1&linked=github&b=2')).toEqual({ linked: 'github', error: null, search: '?a=1&b=2' });
  });
  it('没有这两个参数时什么也不做', () => {
    expect(readOAuthReturn('')).toEqual({ linked: null, error: null, search: '' });
    expect(readOAuthReturn('?x=1')).toEqual({ linked: null, error: null, search: '?x=1' });
  });
});

describe('oauthErrorMessage', () => {
  const CODES = ['reauth_required', 'login_required', 'session_changed', 'identity_taken', 'provider_already_linked', 'access_denied',
    'state_mismatch', 'token_exchange_failed', 'profile_fetch_failed', 'provider_error', 'provider_unavailable', 'rate_limited'];
  it('每个已知码都有自己的一句，且不是通用兜底', () => {
    const generic = oauthErrorMessage('something_else');
    const msgs = CODES.map(oauthErrorMessage);
    for (const m of msgs) { expect(m).toBeTruthy(); expect(m).not.toBe(generic); }
    expect(new Set(msgs).size).toBe(CODES.length);
  });
  it('未知码 / 空值给通用一句', () => {
    expect(oauthErrorMessage(undefined)).toBe(oauthErrorMessage('nope'));
    expect(oauthErrorMessage('nope')).toMatch(/关联/);
  });
});

describe('formatLastSeen', () => {
  const now = new Date(2026, 8, 13, 12, 0, 0).getTime();
  it('一天内说相对时间，更早写本地 yyyy-mm-dd hh:mm', () => {
    expect(formatLastSeen(now - 10_000, now)).toBe('刚刚');
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatLastSeen(now - 3 * 3600_000, now)).toBe('3 小时前');
    expect(formatLastSeen(new Date(2026, 8, 1, 9, 5).getTime(), now)).toBe('2026-09-01 09:05');
  });
  it('没有时间戳返回空串；时钟略快不出负数', () => {
    expect(formatLastSeen(null, now)).toBe('');
    expect(formatLastSeen(now + 30_000, now)).toBe('刚刚');
  });
});

describe('apiJson', () => {
  const fakeFetch = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  it('成功返回 JSON', async () => {
    await expect(apiJson('GET', '/x', undefined, fakeFetch(200, { ok: true }))).resolves.toEqual({ ok: true });
  });
  it('失败抛出服务端的 error，并带 status / code', async () => {
    const err = await apiJson('POST', '/x', {}, fakeFetch(403, { error: '请先验证身份', code: 'REAUTH_REQUIRED' })).catch((e) => e);
    expect(err.message).toBe('请先验证身份');
    expect(err.status).toBe(403);
    expect(isReauthError(err)).toBe(true);
  });
  it('没有 JSON 体时退回 HTTP 状态；网络失败给统一一句', async () => {
    const noBody = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
    const e1 = await apiJson('GET', '/x', undefined, noBody).catch((e) => e);
    expect(e1.message).toBe('HTTP 502');
    expect(e1.code).toBe(null);
    const e2 = await apiJson('GET', '/x', undefined, async () => { throw new TypeError('Failed to fetch'); }).catch((e) => e);
    expect(e2.code).toBe('NETWORK');
  });
  it('有请求体时发 JSON', async () => {
    let seen;
    await apiJson('PUT', '/x', { a: 1 }, async (url, init) => { seen = init; return { ok: true, status: 200, json: async () => ({}) }; });
    expect(seen.headers['content-type']).toBe('application/json');
    expect(seen.body).toBe('{"a":1}');
  });
});

describe('小件', () => {
  it('关联入口地址带 intent=link 与回到设置页', () => {
    expect(linkStartUrl('google')).toBe('/api/auth/oauth/google/start?intent=link&return=%2Fsettings');
  });
  it('服务商与登录方式的显示名', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('other')).toBe('other');
    expect(sessionMethodLabel('google')).toBe('Google 登录');
    expect(sessionMethodLabel('password')).toBe('密码登录');
    expect(sessionMethodLabel('')).toBe('');
  });
});
