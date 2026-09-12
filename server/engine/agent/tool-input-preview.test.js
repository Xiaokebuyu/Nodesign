/**
 * 流式预解算（2026-09-12）：spot 一发就调 ctx.spotPreviewers[工具].solve，解出真落点再发一拍带 solved 的
 * spot；正文继续流时调 grow。batch 档不预解算。
 */
import { describe, it, expect, vi } from 'vitest';
import { pumpToolInputStream } from './tool-input-stream.js';

function mkCtx(previewer) {
  const events = [];
  return { events, ctx: { emit: (e) => events.push(e), counters: { turns: 1 }, workspace: null, spotPreviewers: { mcp__nodesign__write_on_board: previewer } } };
}
const st0 = () => ({ id: 'toolu_x', name: 'mcp__nodesign__write_on_board', field: 'text', spot: ['place', 'near', 'reply_to', 'chain', 'tag', 'width'], buf: '', sent: 0, lastEmit: 0, spotSent: false, filePathSent: false });

describe('tool-input 预解算', () => {
  it('spot 那一拍调 solve，解出来再发一拍 solved；之后的正文增量调 grow', async () => {
    const solve = vi.fn(async () => ({ x: 100, y: 200, w: 336, h: 120, zone: '', how: 'beside', side: 'right' }));
    const grow = vi.fn();
    const { ctx, events } = mkCtx({ solve, grow });
    const st = st0();
    st.buf = '{"near":"assets/a.png","text":"第一';
    pumpToolInputStream(ctx, st, true);
    expect(events).toHaveLength(1);
    expect(events[0].spot).toEqual({ near: 'assets/a.png' });
    expect(solve).toHaveBeenCalledWith({ near: 'assets/a.png', text: '第一' }, 'toolu_x');
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(2);
    expect(events[1].spot).toEqual({ near: 'assets/a.png', solved: { x: 100, y: 200, w: 336, h: 120, zone: '', how: 'beside', side: 'right' } });
    st.buf = '{"near":"assets/a.png","text":"第一句写完了';
    st.lastEmit = 0;
    pumpToolInputStream(ctx, st, true);
    expect(grow).toHaveBeenCalledWith('toolu_x', '第一句写完了');
  });
  it('solve 返回 null（解不出）就不发 solved；没有 previewer 也不出错', async () => {
    const { ctx, events } = mkCtx({ solve: async () => null });
    const st = st0(); st.buf = '{"text":"x"}';
    pumpToolInputStream(ctx, st, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.filter((e) => e.spot?.solved)).toHaveLength(0);
    const bare = { emit: () => {}, counters: { turns: 1 }, workspace: null };
    expect(() => pumpToolInputStream(bare, { ...st0(), buf: '{"text":"y"}' }, true)).not.toThrow();
  });
});
