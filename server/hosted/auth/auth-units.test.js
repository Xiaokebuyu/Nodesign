/**
 * auth-v2 的纯单元部分：验证码限频与按邮箱锁、密码底线、SigV4 签名、内部凭证、WebSocket 登记、From 头编码。
 * 库走 vitest.server.config 的临时库（每个 worker 一份），不碰生产。
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { issueCode, verifyCode, discardCode, supersedeOlderCodes, LIMITS } from './email-codes.js';
import { checkNewPassword } from './password-policy.js';
import { signRequest } from './sigv4.js';
import { fromHeader } from './mailer.js';
import { codeMail, noticeMail } from './mail-templates.js';
import { mintInternalCookie, verifyInternalToken, revokeInternalTokensFor } from '../../auth/internal-credentials.js';
import { trackSocket, closeUserSockets, _socketCount } from '../../ws/auth-sockets.js';

const uniqEmail = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.com`;
const MIN = 60_000;

describe('email-codes：签发限频', () => {
  it('同一邮箱 60 秒内不许重发；满 60 秒可以，且新码作废旧码', () => {
    const email = uniqEmail();
    const t0 = 1_800_000_000_000;
    const a = issueCode({ email, purpose: 'login', ip: '1.1.1.1', now: t0 });
    expect(a.ok).toBe(true);
    const tooSoon = issueCode({ email, purpose: 'login', ip: '1.1.1.1', now: t0 + 30_000 });
    expect(tooSoon).toMatchObject({ ok: false, code: 'RESEND_TOO_SOON' });
    const b = issueCode({ email, purpose: 'login', ip: '1.1.1.1', now: t0 + MIN });
    expect(b.ok).toBe(true);
    // 旧码已作废：拿旧码核验失败（除非两枚码碰巧相同，概率百万分之一，跳过这种情况）
    if (a.code !== b.code) expect(verifyCode({ email, purpose: 'login', code: a.code, now: t0 + MIN + 1 }).ok).toBe(false);
    expect(verifyCode({ email, purpose: 'login', code: b.code, now: t0 + MIN + 2 }).ok).toBe(true);
    // 成功即消耗
    expect(verifyCode({ email, purpose: 'login', code: b.code, now: t0 + MIN + 3 }).ok).toBe(false);
  });

  it('同一邮箱 1 小时最多 5 封', () => {
    const email = uniqEmail();
    const t0 = 1_800_100_000_000;
    for (let i = 0; i < LIMITS.perEmailHour; i += 1) expect(issueCode({ email, purpose: 'signup', now: t0 + i * MIN }).ok).toBe(true);
    expect(issueCode({ email, purpose: 'signup', now: t0 + 10 * MIN })).toMatchObject({ ok: false, code: 'EMAIL_RATE_LIMITED' });
    expect(issueCode({ email, purpose: 'signup', now: t0 + 61 * MIN }).ok).toBe(true);
  });

  it('同一 IP 1 小时最多 20 封（换邮箱也算）', () => {
    const ip = `9.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const t0 = 1_800_200_000_000;
    for (let i = 0; i < LIMITS.perIpHour; i += 1) expect(issueCode({ email: uniqEmail(), purpose: 'login', ip, now: t0 + i }).ok).toBe(true);
    expect(issueCode({ email: uniqEmail(), purpose: 'login', ip, now: t0 + 100 })).toMatchObject({ ok: false, code: 'IP_RATE_LIMITED' });
  });

  it('码过期后核验失败', () => {
    const email = uniqEmail();
    const t0 = 1_800_300_000_000;
    const a = issueCode({ email, purpose: 'reset', now: t0 });
    expect(verifyCode({ email, purpose: 'reset', code: a.code, now: t0 + LIMITS.codeTtlMs + 1 }).ok).toBe(false);
  });

  it('用途不串：login 的码拿去 reset 核验不通过', () => {
    const email = uniqEmail();
    const t0 = 1_800_400_000_000;
    const a = issueCode({ email, purpose: 'login', now: t0 });
    expect(verifyCode({ email, purpose: 'reset', code: a.code, now: t0 + 1 }).ok).toBe(false);
  });
});

describe('email-codes：旧码作废放在发信成功之后', () => {
  it('发信失败撤回新码时，手里的旧码仍然有效；发信成功后旧码作废', () => {
    const email = uniqEmail();
    const t0 = 1_800_700_000_000;
    const a = issueCode({ email, purpose: 'login', now: t0 });
    supersedeOlderCodes(a.id, t0);
    const b = issueCode({ email, purpose: 'login', now: t0 + MIN });
    discardCode(b.id);   // 模拟发信失败
    expect(verifyCode({ email, purpose: 'login', code: a.code, now: t0 + MIN + 1 }).ok).toBe(true);
    const c = issueCode({ email, purpose: 'login', now: t0 + 2 * MIN });
    const d = issueCode({ email, purpose: 'login', now: t0 + 3 * MIN });
    supersedeOlderCodes(d.id, t0 + 3 * MIN);
    if (c.code !== d.code) expect(verifyCode({ email, purpose: 'login', code: c.code, now: t0 + 3 * MIN + 1 }).ok).toBe(false);
  });
});

describe('email-codes：错误按邮箱累计、不分用途（攻击用例）', () => {
  it('攻击：没有待核验的码时乱打错码不计数，锁不住别人的邮箱', () => {
    const email = uniqEmail();
    const t0 = 1_800_800_000_000;
    for (let i = 0; i < LIMITS.failPerDay + 5; i += 1) verifyCode({ email, purpose: 'reset', code: '000000', now: t0 + i });
    const c = issueCode({ email, purpose: 'reset', now: t0 + MIN });
    expect(verifyCode({ email, purpose: 'reset', code: c.code, now: t0 + MIN + 1 }).ok).toBe(true);
  });

  it('login 猜错 25 次后，换 reset 用途拿**正确**的码也被锁', () => {
    const email = uniqEmail();
    const t0 = 1_800_500_000_000;
    issueCode({ email, purpose: 'login', now: t0 });
    for (let i = 0; i < LIMITS.failPerHour; i += 1) {
      expect(verifyCode({ email, purpose: 'login', code: '000000', now: t0 + 1000 + i }).ok).toBe(false);
    }
    const reset = issueCode({ email, purpose: 'reset', now: t0 + 2 * MIN });
    expect(reset.ok).toBe(true);
    const r = verifyCode({ email, purpose: 'reset', code: reset.code, now: t0 + 2 * MIN + 1 });
    expect(r).toMatchObject({ ok: false, code: 'CODE_LOCKED' });
    // 1 小时后小时窗口过去（总数 25 < 日上限 30），恢复
    const later = issueCode({ email, purpose: 'reset', now: t0 + 62 * MIN });
    expect(verifyCode({ email, purpose: 'reset', code: later.code, now: t0 + 62 * MIN + 1 }).ok).toBe(true);
  });

  it('24 小时内累计 30 次错误：跨小时分散猜也被日上限锁住', () => {
    const email = uniqEmail();
    const t0 = 1_800_600_000_000;
    // 每小时先发一枚码、再猜 6 次，猜 5 个小时 = 30 次，都没触发小时上限
    for (let h = 0; h < 5; h += 1) {
      const live = issueCode({ email, purpose: 'login', now: t0 + h * 61 * MIN });
      const wrong = live.code === '111111' ? '222222' : '111111';
      for (let i = 1; i <= 6; i += 1) verifyCode({ email, purpose: 'login', code: wrong, now: t0 + h * 61 * MIN + i });
    }
    const c = issueCode({ email, purpose: 'login', now: t0 + 6 * 61 * MIN });
    expect(verifyCode({ email, purpose: 'login', code: c.code, now: t0 + 6 * 61 * MIN + 1 })).toMatchObject({ ok: false, code: 'CODE_LOCKED' });
  });
});

describe('password-policy', () => {
  it('长度、常见弱密码、重复与连续、等于邮箱前缀或用户名', () => {
    expect(checkNewPassword('short')).toMatchObject({ ok: false, code: 'PASSWORD_TOO_SHORT' });
    expect(checkNewPassword('x'.repeat(129) + 'a')).toMatchObject({ ok: false, code: 'PASSWORD_TOO_LONG' });
    for (const bad of ['password', 'Password', '12345678', 'qwertyuiop', 'woaini1314', 'aaaaaaaaaa', 'abcdefghij', '98765432']) {
      expect(checkNewPassword(bad), bad).toMatchObject({ ok: false, code: 'PASSWORD_TOO_COMMON' });
    }
    expect(checkNewPassword('zhangsan2024', { email: 'zhangsan2024@qq.com' }).ok).toBe(false);
    expect(checkNewPassword('MyNameIsBob', { username: 'mynameisbob' }).ok).toBe(false);
    expect(checkNewPassword('violet-tram-47').ok).toBe(true);
  });
});

describe('sigv4', () => {
  it('对上 AWS 官方文档的示例签名（IAM ListUsers，2015-08-30）', () => {
    const headers = signRequest({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      region: 'us-east-1', service: 'iam', body: '',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      date: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });
});

describe('邮件', () => {
  it('From 头：ASCII 显示名加引号，中文按 RFC 2047 编码', () => {
    expect(fromHeader('NoDesign', 'noreply@x.com')).toBe('"NoDesign" <noreply@x.com>');
    expect(fromHeader('小布语', 'noreply@x.com')).toBe(`=?UTF-8?B?${Buffer.from('小布语').toString('base64')}?= <noreply@x.com>`);
  });
  it('验证码邮件不含链接；中英两版；通知邮件认得全部种类', () => {
    const zh = codeMail({ code: '123456', purpose: 'signup', locale: 'zh-CN' });
    const en = codeMail({ code: '123456', purpose: 'reset', locale: 'en' });
    for (const m of [zh, en]) {
      expect(m.text).toContain('123456');
      expect(m.text + m.html).not.toMatch(/https?:\/\//);
    }
    expect(zh.subject).toMatch(/验证码/);
    expect(en.subject).toMatch(/code/);
    for (const kind of ['password_changed', 'password_reset', 'email_changed', 'email_added']) {
      expect(noticeMail({ kind, locale: 'zh-CN' }).subject).toBeTruthy();
    }
    expect(() => noticeMail({ kind: 'nope' })).toThrow();
  });
});

describe('内部凭证', () => {
  it('签发、核验、按账号吊销；随便编一个值不通过', () => {
    const { name, value } = mintInternalCookie('u_internal_1');
    expect(name).toBe('nd_internal');
    expect(verifyInternalToken(value)).toEqual({ userId: 'u_internal_1' });
    expect(verifyInternalToken('x'.repeat(43))).toBeNull();
    revokeInternalTokensFor('u_internal_1');
    expect(verifyInternalToken(value)).toBeNull();
  });
  it('1 小时后过期', () => {
    const now = Date.now();
    const { value } = mintInternalCookie('u_internal_2', now);
    expect(verifyInternalToken(value, now + 59 * MIN)).not.toBeNull();
    expect(verifyInternalToken(value, now + 61 * MIN)).toBeNull();
  });
});

describe('auth-sockets', () => {
  const fakeWs = () => {
    const ws = new EventEmitter();
    ws.closed = null;
    ws.close = (code) => { ws.closed = code; ws.emit('close'); };
    return ws;
  };
  it('按会话断开、保留某会话、全断；关闭码 4401', () => {
    const a = fakeWs(); const b = fakeWs(); const c = fakeWs();
    trackSocket(a, { user: { id: 'u_ws' }, sessionId: 's1' });
    trackSocket(b, { user: { id: 'u_ws' }, sessionId: 's2' });
    trackSocket(c, { user: { id: 'u_ws' }, sessionId: null });
    expect(_socketCount('u_ws')).toBe(3);
    expect(closeUserSockets('u_ws', { sessionId: 's1' })).toBe(1);
    expect(a.closed).toBe(4401);
    expect(closeUserSockets('u_ws', { exceptSessionId: 's2' })).toBe(1);
    expect(c.closed).toBe(4401);
    expect(b.closed).toBeNull();
    expect(closeUserSockets('u_ws')).toBe(1);
    expect(b.closed).toBe(4401);
    expect(_socketCount('u_ws')).toBe(0);
  });
});
