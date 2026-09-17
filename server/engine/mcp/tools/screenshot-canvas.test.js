/**
 * screenshot_canvas 两处接线（09-17）：
 * - 诊断交给取页出口在 goto 之前挂（iss_mt886uc1_7rne），caption 用出口给的那份
 * - fixed/sticky 警告只在「整页 + 没指定元素」时出：selector / pageIndex 截的是元素自己的盒子，
 *   不涉及展开视口（iss_mtw1ulg7_mi21）；警告里要给出全屏 modal / sheet 的做法
 * 取页与截图管线换成假的，不起浏览器。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ws = mkdtempSync(path.join(tmpdir(), 'nd-shot-0917-'));
mkdirSync(path.join(ws, 'site'));
writeFileSync(path.join(ws, 'site', 'index.html'), '<!doctype html><div id="setup"></div>');

vi.mock('../../../lib/artifact-target.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveCanvasTarget: async () => ({ ok: true, kind: 'site', absPath: path.join(ws, 'site', 'index.html'), relPath: 'site/index.html' }),
  requireBrowsable: () => null,
}));

const acquireCalls = [];
const page = {
  // 有参数 = 取元素盒子（selector 模式）；无参数 = fixed/sticky 探针
  evaluate: async (_fn, arg) => (typeof arg === 'string'
    ? { x: 0, y: 0, width: 390, height: 844, docW: 390, docH: 2000 }
    : ['#setup(fixed)']),
};
vi.mock('./helpers/acquire-page.js', () => ({
  LIVE_PARAM_DESC: 'live',
  acquireArtifactPage: async (o) => {
    acquireCalls.push(o);
    return { page, live: false, viewport: o.viewport, note: null, viaHttp: true, gotoNote: null, liveNote: null,
      diag: { summary: () => 'DIAG-FROM-ACQUIRE' }, release: async () => {} };
  },
}));
vi.mock('./helpers/shot-pipeline.js', async (importOriginal) => ({
  ...(await importOriginal()),
  normalizeShot: async () => ({ data: 'x', mimeType: 'image/webp', note: null }),
  detectPaintTransform: async () => null,
  shotWithFallback: async () => ({ buf: Buffer.from('png'), degraded: false }),
  clipShotWithFallback: async () => ({ buf: Buffer.from('png'), degraded: false }),
  longPageSheet: async () => null,
}));

const { makeScreenshotCanvasTool } = await import('./screenshot.js');
const shoot = (args) => makeScreenshotCanvasTool({ workspaceRoot: ws, projectId: 'p', sessionId: 's' }).handler(args, {});

beforeEach(() => { acquireCalls.length = 0; });

describe('screenshot_canvas 的 fixed/sticky 警告', () => {
  it('整页（站点默认）→ 出警告，并给出全屏 modal / sheet 用 selector 的做法', async () => {
    const r = await shoot({ device: 'mobile' });
    const cap = r.content[0].text;
    expect(cap).toContain('fixed/sticky element(s)');
    expect(cap).toContain('#setup(fixed)');
    expect(cap).toMatch(/full-screen modal \/ sheet .*capture it with selector/);
  });
  it('selector 模式（站点 fullPage 默认仍为 true）→ 不出这条', async () => {
    const r = await shoot({ device: 'mobile', selector: '#setup' });
    expect(r.isError).toBeFalsy();
    const cap = r.content[0].text;
    expect(cap).toContain('selector="#setup"');
    expect(cap).not.toContain('fixed/sticky');
  });
});

describe('screenshot_canvas 的诊断接线', () => {
  it('把 console 档位交给取页出口（由它在 goto 之前挂），caption 用出口给的 diag', async () => {
    const r = await shoot({ console: 'all' });
    expect(acquireCalls[0].diagnostics).toEqual({ console: 'all' });
    expect(r.content[0].text).toContain('DIAG-FROM-ACQUIRE');
  });
});
