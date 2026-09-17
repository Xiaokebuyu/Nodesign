/**
 * 网络闸拒因的文案（09-17）：
 * - DNS 超时与 NXDOMAIN 分开说；全是解析失败时 blockedNote 不说「硬边界」
 * - 撞的是本项目刚发布的站 → 解析还在生效，半分钟后重试（问题库 iss_mu039zaz_vydt：发布 6 秒后截图被拒）
 * - screenshot_url 导航被拒时从闸的记账里拼出拒因（原来只转出 net::ERR_ACCESS_DENIED）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { denyText, _denyInternals } from './browse.js';
import { navFailText } from './screenshot-url.js';
import { upsertPublished } from '../../../lib/publish-store.js';

const DOMAIN = 'share.example-0917.test';
const PID = 'proj_deny_0917';

beforeAll(() => {
  process.env.NODESIGN_PUBLISH_DOMAIN = DOMAIN;
  upsertPublished({ projectId: PID, task: 'bike', userId: null, cfProject: 'nd-bike-0917', url: `https://bike.${DOMAIN}`, customDomain: `bike.${DOMAIN}` });
});

describe('denyText 按 dns 分档', () => {
  it('超时：说重试，不说不存在', () => {
    const t = denyText({ kind: 'dns', dns: 'timeout' }, null, 'https://a.example.com/').join('\n');
    expect(t).toMatch(/超时.*重试一次/);
    expect(t).not.toContain('不存在');
  });
  it('NXDOMAIN：说可能不存在', () => {
    expect(denyText({ kind: 'dns', dns: 'nxdomain' }, null, 'https://a.example.com/').join('\n')).toContain('可能不存在');
  });
  it('策略拦截：硬边界那句', () => {
    expect(denyText({ kind: 'policy' }, null, 'http://127.0.0.1/').join('\n')).toContain('硬边界');
  });
});

describe('撞的是本项目的发布域', () => {
  it('刚发布的本项目站点 → 解析还在生效，半分钟后重试', () => {
    const t = denyText({ kind: 'dns', dns: 'nxdomain' }, PID, `https://bike.${DOMAIN}/`).join('\n');
    expect(t).toContain('刚刚发布的站点');
    expect(t).toContain('半分钟后重试');
    expect(t).not.toContain('不是本项目当前的线上地址');
  });
  it('发布很久的本项目站点 → 不说「刚发布」，交给用户', () => {
    const old = { url: `https://bike.${DOMAIN}`, lastPublishedAt: '2026-01-01 00:00:00' };
    const t = _denyInternals.ownSiteDnsText(old, Date.parse('2026-09-17T00:00:00Z'));
    expect(t).toContain('登记的线上地址');
    expect(t).not.toContain('刚');
    const recent = _denyInternals.ownSiteDnsText({ lastPublishedAt: '2026-09-17 00:00:00' }, Date.parse('2026-09-17T00:03:30Z'));
    expect(recent).toContain(' 3 分钟前发布的站点');
  });
  it('同一发布域下别的主机 → 照旧给出本项目现在的线上地址', () => {
    const t = denyText({ kind: 'dns', dns: 'nxdomain' }, PID, `https://old-slug.${DOMAIN}/`).join('\n');
    expect(t).toContain('不是本项目当前的线上地址');
    expect(t).toContain(`https://bike.${DOMAIN}`);
  });
});

describe('blockedNote', () => {
  const rec = (kind) => ({ url: 'https://x.example.com/a', reason: `r-${kind}`, stage: 'request', kind });
  it('全是解析失败 → 不说硬边界', () => {
    const n = _denyInternals.blockedNote({ blocked: [rec('dns')] }, 0);
    expect(n).toContain('域名解析失败，不是出网策略拦截');
    expect(n).not.toContain('硬边界');
  });
  it('混有策略拦截 → 硬边界', () => {
    expect(_denyInternals.blockedNote({ blocked: [rec('dns'), rec('policy')] }, 0)).toContain('硬边界');
  });
});

describe('screenshot_url 的 navFailText', () => {
  const err = new Error('page.goto: net::ERR_ACCESS_DENIED at https://bike.share.example-0917.test/\nCall log:\n  - navigating');
  it('CDP 闸的记账 → 拒因 + 分档文案 + 刚发布提示；只留报错首行', () => {
    const t = navFailText(`https://bike.${DOMAIN}`, err, {
      records: [{ url: `https://bike.${DOMAIN}/`, reason: `cannot resolve bike.${DOMAIN}: getaddrinfo ENOTFOUND`, stage: 'request', kind: 'dns', dns: 'nxdomain' }],
      projectId: PID, host: `bike.${DOMAIN}`,
    });
    expect(t).toContain(`Failed to load https://bike.${DOMAIN}: page.goto: net::ERR_ACCESS_DENIED`);
    expect(t).not.toContain('Call log');
    expect(t).toContain(`网络闸的拒因：cannot resolve bike.${DOMAIN}`);
    expect(t).toContain('半分钟后重试');
  });
  it('只有代理那道的记账 → 按主机取，别家的记录不串', () => {
    const t = navFailText('https://a.example.com', err, {
      proxyRecords: [
        { target: 'other.example.com:443', reason: 'other-host', kind: 'policy' },
        { target: 'a.example.com:443', reason: 'cannot resolve a.example.com: dns timeout', kind: 'dns', dns: 'timeout' },
      ],
      host: 'a.example.com',
    });
    expect(t).toContain('网络闸的拒因：cannot resolve a.example.com: dns timeout');
    expect(t).toMatch(/超时.*重试一次/);
    expect(t).not.toContain('other-host');
  });
  it('没有记账但是 ERR_ACCESS_DENIED → 明说没留下拒因', () => {
    expect(navFailText('https://a.example.com', err, { host: 'a.example.com' })).toContain('没有留下拒因记录');
  });
  it('别的失败（连接被拒）原样', () => {
    const t = navFailText('https://a.example.com', new Error('page.goto: net::ERR_CONNECTION_REFUSED'), { host: 'a.example.com' });
    expect(t).toBe('Failed to load https://a.example.com: page.goto: net::ERR_CONNECTION_REFUSED');
  });
});
