/**
 * 感知页的两条报错（09-17，问题库 iss_mtdfvijv_pn5h）：
 * - 点开头的目录预览通道不服（artifact-file 的白名单是有意的），起浏览器之前就说清楚
 * - 仍然拿到 ≥400 时，把路由 JSON 里的 error 拼进报错，别只给状态码
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../auth/session.js', () => ({ authEnabled: () => false }));

const { previewPathProblem, openArtifactPage } = await import('./perception-page.js');

/** 假浏览器：goto 回一个给定状态码和 JSON 体的响应，记录有没有开过 context */
function fakeBrowser({ status = 200, body = null } = {}) {
  const seen = { contexts: 0, gotoUrl: null };
  const page = {
    goto: async (url) => {
      seen.gotoUrl = url;
      return { status: () => status, json: async () => { if (body == null) throw new Error('not json'); return body; } };
    },
  };
  return {
    seen,
    newContext: async () => { seen.contexts += 1; return { route: async () => {}, newPage: async () => page }; },
  };
}

describe('previewPathProblem', () => {
  it('路径里有点开头的段 → 一句可执行的话（说清为什么、临时页该放哪、用完删）', () => {
    const msg = previewPathProblem('/ws', '/ws/jet-engine/.scratch/perf/index.html');
    expect(msg).toContain('jet-engine/.scratch/perf/index.html');
    expect(msg).toContain('not served by the preview channel');
    expect(msg).toContain('does not start with "."');
    expect(msg).toContain('delete them when done');
  });
  it('白名单里的点目录（.thumbnails / .meta）、普通路径、工作区外 → null', () => {
    expect(previewPathProblem('/ws', '/ws/assets/generated/.thumbnails/a.png')).toBeNull();
    expect(previewPathProblem('/ws', '/ws/site/index.html')).toBeNull();
    expect(previewPathProblem('/ws', '/elsewhere/.x/index.html')).toBeNull();
    expect(previewPathProblem('', '/ws/.x/index.html')).toBeNull();
  });
});

describe('openArtifactPage 的报错', () => {
  it('点开头目录：不开 context 就抛（所有直接调它的入口都覆盖到）', async () => {
    const b = fakeBrowser();
    await expect(openArtifactPage(b, { projectId: 'p', workspaceRoot: '/ws', absPath: '/ws/.scratch/index.html' }))
      .rejects.toThrow(/\.scratch\/index\.html cannot be opened/);
    expect(b.seen.contexts).toBe(0);
  });

  it('≥400：报错里带上路由 JSON 的 error 字段', async () => {
    const b = fakeBrowser({ status: 403, body: { error: 'path escapes workspace (symlinks are resolved before the check)' } });
    const opened = await openArtifactPage(b, { projectId: 'p', workspaceRoot: '/ws', absPath: '/ws/site/index.html' });
    expect(opened.viaHttp).toBe(true);
    await expect(opened.goto()).rejects.toThrow(
      'artifact-file returned HTTP 403 (path escapes workspace (symlinks are resolved before the check)) for /api/projects/p/artifact-file/site/index.html?nd=raw',
    );
  });

  it('≥400 且响应体不是 JSON：照旧只报状态码，不因为读体失败而换成别的错', async () => {
    const b = fakeBrowser({ status: 404 });
    const opened = await openArtifactPage(b, { projectId: 'p', workspaceRoot: '/ws', absPath: '/ws/site/index.html' });
    await expect(opened.goto()).rejects.toThrow(/^artifact-file returned HTTP 404 for /);
  });
});
