// 出网地址闸（2026-08-18）。按「装了闸就真去攻一遍」的规矩写：每一条都是一种
// 真实的绕过手法，不是把实现复述一遍。
//
// ⚠️ 这里只钉**地址算术**。真正抓到两个漏洞的是端到端攻击矩阵
// `server/lib/ssrf-lab/attack.mjs`（必须真联网，所以不进测试套件）——
// 「跳转的第二跳」「跨源 iframe」「初始化竞态」这三类**单测结构上看不见**。
// 改过 ssrf-guard.js 就手跑一次那个。
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { blockReason, checkUrl, ownAddresses } from './ssrf-guard.js';

describe('blockReason —— 按 IP 判', () => {
  it('loopback / 私网 / 元数据一律禁', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.254',
      '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(blockReason(ip), ip).toBeTruthy();
    }
    // 托管站点上 fake-ip 段（198.18/15）照拦；本地版放行那面在 ssrf-guard.fakeip.test.js
    expect(blockReason('198.18.1.236')).toMatch(/reserved/);
  });

  it('真公网放行', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(blockReason(ip), ip).toBeNull();
    }
  });

  it('⭐ 172.16/12 的边界不能算错（172.15 和 172.32 是公网）', () => {
    expect(blockReason('172.15.255.255')).toBeNull();
    expect(blockReason('172.16.0.0')).toBeTruthy();
    expect(blockReason('172.31.255.255')).toBeTruthy();
    expect(blockReason('172.32.0.0')).toBeNull();
  });

  it('IPv6 loopback / ULA / link-local / 组播禁，公网 v6 放行', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(blockReason(ip), ip).toBeTruthy();
    }
    expect(blockReason('2606:4700:4700::1111')).toBeNull();
  });

  it('⭐ IPv4-mapped 要拆开按 v4 判（`::ffff:127.0.0.1` 是经典绕过）', () => {
    expect(blockReason('::ffff:127.0.0.1')).toBeTruthy();
    expect(blockReason('::ffff:7f00:1')).toBeTruthy();        // 十六进制写法
    expect(blockReason('64:ff9b::169.254.169.254')).toBeTruthy();  // NAT64 打元数据
    expect(blockReason('::ffff:8.8.8.8')).toBeNull();
  });

  it('带方括号 / 带 zone id 也认', () => {
    expect(blockReason('[::1]')).toBeTruthy();
    expect(blockReason('fe80::1%eth0')).toBeTruthy();
  });

  it('⭐ 本机自有 IP 一律禁（我们的 API 绑 *:PORT，绕本机公网 IP 打自己是一样的）', () => {
    const own = [...ownAddresses()].filter(a => !a.startsWith('127.') && a !== '::1');
    // 这台机器至少有一个非 loopback 地址；没有的话这条断言没意义，跳过而不是假过
    if (!own.length) return;
    for (const a of own) expect(blockReason(a), a).toMatch(/own address/);
  });

  it('本机地址枚举跟 os 对得上', () => {
    const flat = Object.values(os.networkInterfaces()).flat().map(a => a.address.toLowerCase());
    for (const a of flat) expect(ownAddresses().has(a.replace(/%.*$/, ''))).toBe(true);
  });
});

describe('checkUrl —— 按 URL 判', () => {
  it('非 http(s) 的出网 scheme 全拒（file:// 会变成本地文件读取）', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://x/y', 'chrome://version', 'view-source:http://a/']) {
      expect((await checkUrl(u)).ok, u).toBe(false);
    }
  });

  it('data: / blob: / about: 放行（不出网，不能 SSRF）', async () => {
    for (const u of ['data:text/html,<p>x', 'about:blank']) {
      expect((await checkUrl(u)).ok, u).toBe(true);
    }
  });

  it('字面量内网地址拒，且不劳烦 DNS', async () => {
    const r = await checkUrl('http://127.0.0.1:4001/api/health');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/private|own address/);
    expect((await checkUrl('http://[::1]:4001/')).ok).toBe(false);
    expect((await checkUrl('http://169.254.169.254/computeMetadata/v1/')).ok).toBe(false);
  });

  it('localhost / *.local / *.localhost 拒', async () => {
    for (const u of ['http://localhost:4001/', 'http://foo.local/', 'http://a.localhost/']) {
      expect((await checkUrl(u)).ok, u).toBe(false);
    }
  });

  it('解析不出来的域名拒（不是"放行等它自己失败"）', async () => {
    const r = await checkUrl('http://nx-should-not-resolve-8f3a2b1c.example/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot resolve|resolved to nothing/);
  });

  it('乱码 URL 拒', async () => {
    expect((await checkUrl('not a url')).ok).toBe(false);
    expect((await checkUrl('')).ok).toBe(false);
    expect((await checkUrl(null)).ok).toBe(false);
  });
});
