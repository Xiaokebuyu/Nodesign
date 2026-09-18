// publish_site 失败要标 isError（09-18 调查：失败走 asText，卡片显示成功、PostToolUseFailure 不触发、问题库不记，
// 生产 3 次，例「发布操作失败：这个站点正在发布中，稍等」）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../projects/store.js', () => ({ getProject: (id) => (id === 'proj_gone' ? null : { id, ownerId: 'u1' }) }));
vi.mock('../../../auth/users-store.js', () => ({ getUserById: () => ({ id: 'u1' }) }));
vi.mock('../../../lib/site-publish.js', () => ({
  publishSite: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); },
  unpublishSite: async () => true,
  lookupPublished: async () => null,
}));
const { makePublishSiteTool } = await import('./publish-site.js');
const run = (pid, args) => makePublishSiteTool({ projectId: pid }).handler(args, {});

describe('publish_site 的失败', () => {
  it('⭐ 发布抛错：标 isError，正文带上 cause 里的真原因', async () => {
    const r = await run('proj_ok', { task: '站', action: 'publish' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('发布操作失败：fetch failed（read ECONNRESET）');
  });

  it('项目没了也标 isError', async () => {
    expect((await run('proj_gone', { task: '站', action: 'publish' })).isError).toBe(true);
  });

  it('成功的查询不标', async () => {
    const r = await run('proj_ok', { task: '站', action: 'status' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('未发布');
  });
});
