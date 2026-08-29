// 「这句话是对哪个角色说的」（2026-08-26 建；08-29 改写：去向只剩主持人一个）
import { describe, it, expect } from 'vitest';
import { soleRoleTarget, sayToRoleText } from './role-target.js';

const chalk = (by, byName) => ({ id: 'notes/板书/a.md', title: '一段', by, ...(byName ? { byName } : {}) });

describe('认出收件人', () => {
  it('全指着同一个角色 → 认出来，带展示名', () => {
    expect(soleRoleTarget([chalk('rp-moli', '墨璃'), chalk('rp-moli', '墨璃')]))
      .toEqual({ slug: 'rp-moli', who: '墨璃' });
  });
  it('⭐ 混选了别人的东西 → 认不出（说不清在跟谁说话，当成跟主持人说）', () => {
    expect(soleRoleTarget([chalk('rp-moli'), chalk('agent')])).toBeNull();
    expect(soleRoleTarget([chalk('rp-moli'), chalk('rp-other')])).toBeNull();
    expect(soleRoleTarget([chalk('rp-moli'), { id: 'x', title: 'deck' }])).toBeNull();
  });
  it('主持人 / 用户写的东西没有收件人', () => {
    expect(soleRoleTarget([chalk('agent')])).toBeNull();
    expect(soleRoleTarget([chalk('user')])).toBeNull();
    expect(soleRoleTarget([])).toBeNull();
  });
  it('没有展示名就报 slug（宁可难看也不能张冠李戴）', () => {
    expect(soleRoleTarget([chalk('rp-moli')]).who).toBe('rp-moli');
  });
});

describe('⭐ 转交给主持人的话术：收件人说清楚，原话一个字不改', () => {
  it('带落点时把落点一起给出去 —— 角色回帖要靠它接上这条线', () => {
    const out = sayToRoleText({ who: '墨璃', slug: 'rp-moli', text: '你还好吗', echo: 'notes/板书/e.md' });
    expect(out).toContain('墨璃');
    expect(out).toContain('rp-moli');
    expect(out).toContain('你还好吗');
    expect(out).toContain('notes/板书/e.md');
  });
  it('没落点就不提落点（别编一个不存在的路径给主持人）', () => {
    const out = sayToRoleText({ who: '墨璃', slug: 'rp-moli', text: '继续' });
    expect(out).not.toContain('画布上');
    expect(out).toContain('继续');
  });
});
