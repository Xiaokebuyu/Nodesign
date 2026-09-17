import { describe, it, expect } from 'vitest';
import { artifactThumbUrl } from './artifact-thumb.js';

/** 远景缩略图地址（09-17，问题库 iss_mu0v5pa5_3ojg） */
describe('artifactThumbUrl', () => {
  it('路径、形态、版本号都进查询串，中文与空格编码', () => {
    const u = new URL(artifactThumbUrl('p1', '我的 站/index.html', { kind: 'site', v: 7 }), 'http://x');
    expect(u.pathname).toBe('/api/projects/p1/artifact-thumb');
    expect(u.searchParams.get('path')).toBe('我的 站/index.html');
    expect(u.searchParams.get('kind')).toBe('site');
    expect(u.searchParams.get('v')).toBe('7');
  });
  it('版本号为 0 不带 v（地址稳定，浏览器缓存才用得上）', () => {
    expect(artifactThumbUrl('p1', 'a.html', { kind: 'deck', v: 0 })).toBe('/api/projects/p1/artifact-thumb?path=a.html&kind=deck');
  });
  it('& 与 # 不会截断查询串', () => {
    const u = new URL(artifactThumbUrl('p1', 'a&b#c.html', { kind: 'deck' }), 'http://x');
    expect(u.searchParams.get('path')).toBe('a&b#c.html');
  });
});
