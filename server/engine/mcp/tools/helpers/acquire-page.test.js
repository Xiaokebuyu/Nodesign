/**
 * acquire-page 的挂监听时机（09-17，问题库 iss_mt886uc1_7rne）。
 *
 * 08-21 把取页收进 acquireArtifactPage 之后，它返回前已经 goto 完，screenshot / trace_motion
 * 拿到页面再挂诊断，加载期的失败请求与控制台错误全部错过，白屏站的 caption 仍是
 * 「console clean, all requests OK」。screenshot-diag.test.js 用的假页面不经过取页，
 * 顺序覆盖不到；这里用记录调用顺序的假 page / opened 钉住「先挂监听，再导航」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const calls = [];
vi.mock('./perception-page.js', async (importOriginal) => ({
  ...(await importOriginal()),
  launchPerceptionBrowser: vi.fn(async () => { calls.push('launch'); return { close: async () => calls.push('close') }; }),
  openArtifactPage: vi.fn(),
}));
vi.mock('./browser-slots.js', () => ({
  gatedBrowser: async (fn) => fn(),
  browserSlots: { acquire: async () => () => {} },
}));
vi.mock('../../../perception/session.js', () => ({ lockSession: vi.fn() }));

const { acquireArtifactPage } = await import('./acquire-page.js');
const { openArtifactPage, launchPerceptionBrowser } = await import('./perception-page.js');
const { lockSession } = await import('../../../perception/session.js');

/** 记录 on / off 顺序的假页面；emit 模拟浏览器在导航期间发事件 */
function recordingPage() {
  const handlers = {};
  return {
    handlers,
    on(evt, cb) { calls.push(`on:${evt}`); (handlers[evt] ||= []).push(cb); },
    off(evt, cb) { calls.push(`off:${evt}`); handlers[evt] = (handlers[evt] || []).filter((h) => h !== cb); },
    emit(evt, arg) { for (const h of handlers[evt] || []) h(arg); },
  };
}

const target = { absPath: '/ws/site/index.html', relPath: 'site/index.html' };

beforeEach(() => {
  calls.length = 0;
  vi.mocked(openArtifactPage).mockReset();
  vi.mocked(launchPerceptionBrowser).mockClear();
});

describe('acquireArtifactPage 的诊断监听时机', () => {
  it('一次性模式：诊断监听挂在 goto 之前，导航期间的失败请求与控制台错误进 summary', async () => {
    const page = recordingPage();
    vi.mocked(openArtifactPage).mockImplementation(async () => {
      calls.push('open');
      return {
        page, note: null, viaHttp: true,
        goto: async () => {
          calls.push('goto');
          // 加载期发生的事：module script 拿到 404、控制台报 MIME 拒绝执行
          page.emit('requestfailed', { method: () => 'GET', url: () => 'http://127.0.0.1:4001/assets/index-x.js', failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
          page.emit('console', { type: () => 'error', text: () => 'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".' });
        },
      };
    });
    const acq = await acquireArtifactPage({ projectId: 'p', workspaceRoot: '/ws', target, diagnostics: {} });
    const firstOn = calls.findIndex((c) => c.startsWith('on:'));
    expect(firstOn).toBeGreaterThan(-1);
    expect(firstOn).toBeLessThan(calls.indexOf('goto'));
    const s = acq.diag.summary();
    expect(s).not.toContain('all requests OK');
    expect(s).toContain('index-x.js');
    expect(s).toContain('Failed to load module script');
    await acq.release();
    expect(calls).toContain('close');
  });

  it('不传 diagnostics 就不挂（其它量具的行为不变）', async () => {
    const page = recordingPage();
    vi.mocked(openArtifactPage).mockResolvedValue({ page, note: null, viaHttp: true, goto: async () => calls.push('goto') });
    const acq = await acquireArtifactPage({ projectId: 'p', workspaceRoot: '/ws', target });
    expect(acq.diag).toBeNull();
    expect(calls.some((c) => c.startsWith('on:'))).toBe(false);
  });

  it('live 模式：挂在会话页上，release 时摘掉（常驻页面不累积监听）', async () => {
    const page = recordingPage();
    page.url = () => 'http://127.0.0.1:4001/api/projects/p/artifact-file/site/index.html';
    let unlocked = false;
    vi.mocked(lockSession).mockResolvedValue({
      entry: { page, target, viewport: { width: 1440, height: 900 }, note: null, viaHttp: true },
      release: () => { unlocked = true; },
    });
    const acq = await acquireArtifactPage({ projectId: 'p', workspaceRoot: '/ws', target, live: true, diagnostics: {} });
    expect(Object.values(page.handlers).flat().length).toBe(4);
    await acq.release();
    expect(Object.values(page.handlers).flat().length).toBe(0);
    expect(unlocked).toBe(true);
    expect(launchPerceptionBrowser).not.toHaveBeenCalled();
  });

  it('点开头目录（预览通道不服）：不起浏览器，直接报可执行的原因（iss_mtdfvijv_pn5h）', async () => {
    const dotTarget = { absPath: '/ws/jet-engine/.scratch/perf/index.html', relPath: 'jet-engine/.scratch/perf/index.html' };
    await expect(acquireArtifactPage({ projectId: 'p', workspaceRoot: '/ws', target: dotTarget, diagnostics: {} }))
      .rejects.toThrow(/starting with "\."/);
    expect(launchPerceptionBrowser).not.toHaveBeenCalled();
    expect(openArtifactPage).not.toHaveBeenCalled();
  });
});

describe('调用方不许在拿到页面之后自己挂诊断', () => {
  it('tools/ 下调用 acquireArtifactPage 的文件不再直接调 attachPageDiagnostics（改传 diagnostics）', () => {
    const toolsDir = path.resolve(import.meta.dirname, '..');
    const offenders = readdirSync(toolsDir)
      .filter((f) => f.endsWith('.js') && !f.includes('.test.'))
      .filter((f) => {
        const src = readFileSync(path.join(toolsDir, f), 'utf8');
        return /\bacquireArtifactPage\s*\(/.test(src) && /\battachPageDiagnostics\s*\(/.test(src);
      });
    expect(offenders, '这些工具在 acquireArtifactPage 返回（已 goto 完）之后才挂诊断，加载期的失败会全部漏掉').toEqual([]);
  });
});
