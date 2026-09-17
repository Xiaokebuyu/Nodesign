/**
 * artifact_computer 的失效 ref 文案（09-17）：会话页上的 ref 失效，要指回 artifact_find，
 * 不能沿用浏览通道的 browser_find（那是另一只浏览器，上面根本没有这一页）。
 * 会话登记处换成假的，不起浏览器。
 */
import { describe, it, expect, vi } from 'vitest';

const page = {
  url: () => 'http://127.0.0.1:4001/api/projects/p/artifact-file/site/index.html',
  isClosed: () => false,
  on: () => {}, off: () => {},
  waitForTimeout: async () => {},
  evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
  mouse: { move: async () => {}, click: async () => {} },
  keyboard: { down: async () => {}, up: async () => {} },
};
vi.mock('../../perception/session.js', () => ({
  withSession: async (_pid, fn) => fn({ page, frame: { w: 1152, h: 720, scale: 0.8 } }),
  changedSinceOpen: async () => [],
  openSession: async () => { throw new Error('not used'); },
  peekSession: () => null,
  defaultViewportFor: async () => ({ width: 1440, height: 900 }),
}));

const { makeArtifactComputerTool } = await import('./artifact-session.js');

describe('artifact_computer：失效 ref 指回 artifact_find', () => {
  it('left_click 一个已失效的 ref', async () => {
    const t = makeArtifactComputerTool({ projectId: 'p' });
    const r = await t.handler({ action: 'left_click', ref: 'ref_4' }, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Call artifact_find again');
    expect(r.content[0].text).not.toContain('browser_find');
  });
});
