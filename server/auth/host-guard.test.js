/** 本地版 Host 闸（09-13 fable 审查中-2）：挡 DNS rebinding，回环名、IP 字面量与白名单放行；hosted 不判。 */
import { describe, it, expect, afterEach } from 'vitest';
import { hostAllowed, _resetOriginCache } from './origin-guard.js';

const req = (host) => ({ headers: host == null ? {} : { host } });

describe('hostAllowed', () => {
  afterEach(() => { delete process.env.ND_ALLOWED_ORIGINS; _resetOriginCache(); });

  it('本地版：回环名与 IP 字面量放行', () => {
    for (const h of ['127.0.0.1:4001', 'localhost:5174', '[::1]:4001', 'LOCALHOST:1', '192.168.1.8:4001', '[fe80::1]:4001', undefined]) {
      expect(hostAllowed(req(h), { isLocal: true }), String(h)).toBe(true);
    }
  });
  it('本地版：域名一律拒（rebinding 后 Host 是攻击者的域名）', () => {
    for (const h of ['evil.com:4001', 'localhost.evil.com:4001', '127.0.0.1.nip.io:4001', 'nodesign.xiaobuyu.trade']) {
      expect(hostAllowed(req(h), { isLocal: true }), h).toBe(false);
    }
  });
  it('白名单里的域名放行；hosted 不判', () => {
    process.env.ND_ALLOWED_ORIGINS = 'http://my-box.lan:4001';
    _resetOriginCache();
    expect(hostAllowed(req('my-box.lan:4001'), { isLocal: true })).toBe(true);
    expect(hostAllowed(req('evil.com'), { isLocal: false })).toBe(true);
  });
});
