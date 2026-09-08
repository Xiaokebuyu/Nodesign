/**
 * 198.18.0.0/15 的两种口径（09-08 桌面版实撞 www.andidea.jp → 198.18.1.236 被拒）：
 * 本地版 = 用户自己的机器，Clash / Surge fake-ip 模式把所有域名解析到这一段 → 放行；托管站点照旧拦。
 * profile 是加载期定死的（NODESIGN_PROFILE），所以两种口径各起一个 vitest 进程分开测：这里是 local，
 * hosted 那面在 ssrf-guard.test.js 里（默认 profile）。
 */
import { describe, it, expect } from 'vitest';
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_ROOT = process.env.NODESIGN_DATA_ROOT || `/tmp/nd-fakeip-${process.pid}`;
const { blockReason } = await import('./ssrf-guard.js');

describe('ssrf-guard 本地版：fake-ip 段放行，其余保留段照拦', () => {
  it('198.18.x.x / 198.19.x.x 放行', () => {
    expect(blockReason('198.18.1.236')).toBeNull();
    expect(blockReason('198.19.255.1')).toBeNull();
  });
  it('内网、loopback、元数据、TEST-NET 仍然拦', () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '198.51.100.1', '100.64.0.1']) {
      expect(blockReason(ip), ip).toMatch(/private|own address/);
    }
  });
});
