/**
 * browser_read 选择器没命中（09-17）：返回里要有页面实有的地标与「读全页」这条路，
 * 不能只有一句「没匹配到」。常驻浏览器换成假的。
 */
import { describe, it, expect, vi } from 'vitest';
import { pageLandmarks } from '../../browse/page-digest.js';

const doc = { querySelectorAll: (sel) => ({ main: [{}], 'body [id]': [{ tagName: 'DIV', id: 'app' }] }[sel] || []) };
const page = {
  evaluate: async (fn) => (fn === pageLandmarks ? fn(doc) : { missing: true }),
  title: async () => 'Demo',
  url: () => 'https://demo.example.com/',
};
vi.mock('../../browse/registry.js', () => ({
  withBrowser: async (_pid, fn) => fn({ page, guard: { blocked: [] } }),
  peek: () => null,
  hold: () => () => {},
  _limits: { NAV_TIMEOUT_MS: 1000, MAX_RESIDENT: 2, IDLE_MS: 60_000, VIEWPORT: { width: 1366, height: 768 } },
}));

const { makeBrowserReadTool } = await import('./browse.js');

describe('browser_read 选择器没命中', () => {
  it('列出实有地标（带数量）并给「去掉 selector 读全页」', async () => {
    const r = await makeBrowserReadTool({ projectId: 'p' }).handler({ selector: '.pricing' }, {});
    expect(r.isError).toBe(true);
    const t = r.content[0].text;
    expect(t).toContain('选择器没匹配到元素：.pricing');
    expect(t).toContain('main（1）、#app（1）');
    expect(t).toContain('去掉 selector 读全页');
  });
});
