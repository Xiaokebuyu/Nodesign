/** live-turn 快照带正在流的入参（09-13，缺口 2）：流到一半重连，画布直播卡能从快照续上。 */
import { describe, it, expect } from 'vitest';
import { attachLiveTurnTracker, getLiveTurnSnapshot } from './live-turn.js';

function makeBus() {
  const subs = [];
  let seq = 0;
  const bus = { subscribe: (_t, fn) => subs.push(fn), publish: (evt) => { const e = { ...evt, seq: ++seq }; subs.forEach((fn) => fn(e)); return e; } };
  attachLiveTurnTracker(bus);
  return bus;
}
const SID = 'sess-stream-1';
const base = { sessionId: SID, runId: 'run_1' };

describe('live-turn 快照里的直播入参', () => {
  it('⭐ 两个块交错流：各自累加，快照带上全文与位置；完整入参到了就清掉那一块', () => {
    const bus = makeBus();
    bus.publish({ ...base, type: 'run.start' });
    bus.publish({ ...base, type: 'run.tool_use.started', blockId: 'b1', name: 'Write' });
    bus.publish({ ...base, type: 'run.delta.tool_input', blockId: 'b1', name: 'Write', filePath: 'site/index.html', append: '<html>' });
    bus.publish({ ...base, type: 'run.tool_use.started', blockId: 'b2', name: 'mcp__nodesign__write_on_board' });
    bus.publish({ ...base, type: 'run.delta.tool_input', blockId: 'b2', name: 'mcp__nodesign__write_on_board', spot: { near: 'x' }, append: '第一' });
    bus.publish({ ...base, type: 'run.delta.tool_input', blockId: 'b1', name: 'Write', append: '<body>' });
    bus.publish({ ...base, type: 'run.delta.tool_input', blockId: 'b2', name: 'mcp__nodesign__write_on_board', spot: { near: 'x', solved: { x: 1, y: 2 } } });
    bus.publish({ ...base, type: 'run.delta.tool_input', blockId: 'b2', name: 'mcp__nodesign__write_on_board', append: '段' });
    let snap = getLiveTurnSnapshot(SID);
    const byId = Object.fromEntries(snap.streams.map((x) => [x.blockId, x]));
    expect(byId.b1).toMatchObject({ name: 'Write', filePath: 'site/index.html', text: '<html><body>' });
    expect(byId.b2).toMatchObject({ text: '第一段', spot: { near: 'x', solved: { x: 1, y: 2 } } });

    bus.publish({ ...base, type: 'run.delta.tool_use', blockId: 'b1', name: 'Write', input: { file_path: '/abs/site/index.html', content: '<html><body></body></html>' } });
    snap = getLiveTurnSnapshot(SID);
    expect(snap.streams.map((x) => x.blockId)).toEqual(['b2']);
  });

  it('reset（批里换了一条）另起：不跟前一条粘在一起', () => {
    const bus = makeBus();
    const S = { sessionId: 'sess-stream-2', runId: 'run_2' };
    bus.publish({ ...S, type: 'run.start' });
    bus.publish({ ...S, type: 'run.delta.tool_input', blockId: 'b9', name: 'mcp__nodesign__write_on_board', append: '旧' });
    bus.publish({ ...S, type: 'run.delta.tool_input', blockId: 'b9', name: 'mcp__nodesign__write_on_board', reset: true, append: '新' });
    expect(getLiveTurnSnapshot('sess-stream-2').streams[0].text).toBe('新');
  });

  it('回合收尾后的 grace 快照不带直播', () => {
    const bus = makeBus();
    const S = { sessionId: 'sess-stream-3', runId: 'run_3' };
    bus.publish({ ...S, type: 'run.start' });
    bus.publish({ ...S, type: 'run.delta.tool_input', blockId: 'b1', name: 'Edit', append: 'x' });
    bus.publish({ ...S, type: 'run.done' });
    expect(getLiveTurnSnapshot('sess-stream-3')).toMatchObject({ running: false, streams: [] });
  });
});
