import { describe, it, expect } from 'vitest';
import { restoreStageCards } from './stage-restore.js';
import { stageKindOf } from './stage.js';

const deps = {
  kindOf: stageKindOf,
  resolve: (p) => (p === 'site/index.html' ? 'site' : null),
  newCard: (evt, kind) => ({ blockId: evt.blockId, kind, tool: evt.name, status: 'running', text: '', filePath: null, objectId: null, oldString: null }),
};

describe('restoreStageCards（重连续上直播卡）', () => {
  it('⭐ 刷新后没有卡：按快照立卡，带全文、文件目标与位置', () => {
    const out = restoreStageCards({}, [
      { blockId: 'b1', name: 'Write', filePath: 'site/index.html', text: '<html><body>' },
      { blockId: 'b2', name: 'mcp__nodesign__write_on_board', spot: { near: 'x', solved: { x: 1, y: 2 } }, text: '第一段' },
    ], deps);
    expect(out.b1).toMatchObject({ kind: 'code', text: '<html><body>', filePath: 'site/index.html', objectId: 'site', status: 'running' });
    expect(out.b2).toMatchObject({ kind: 'chalk', text: '第一段', spot: { solved: { x: 1, y: 2 } } });
  });
  it('本地卡只有重连后的半截：用快照全文补上；本地更长则不倒退', () => {
    const prev = { b1: { ...deps.newCard({ blockId: 'b1', name: 'Write' }, 'code'), text: 'body>' } };
    expect(restoreStageCards(prev, [{ blockId: 'b1', name: 'Write', text: '<html><body>' }], deps).b1.text).toBe('<html><body>');
    const longer = { b1: { ...prev.b1, text: '<html><body></body>' } };
    expect(restoreStageCards(longer, [{ blockId: 'b1', name: 'Write', text: '<html><body>' }], deps)).toBe(longer);
  });
  it('不上舞台的工具（子代理等）忽略；空快照返回原对象', () => {
    const prev = {};
    expect(restoreStageCards(prev, [{ blockId: 't', name: 'Agent', text: 'x' }], deps)).toBe(prev);
    expect(restoreStageCards(prev, [], deps)).toBe(prev);
  });
});
