/**
 * 新纸预告（2026-08-30 刀④）：batch = [open_sheet, write{slot}] 时，流式 spot 要带
 * freshSheet + 那个 slot 的规划矩形 —— 否则前端只能把预览画在上一张纸上（偏一整屏）
 * 或空地（叠一堆），正是站主看到的「都集中在一处流式、batch 完了才归位」。
 */
import { describe, it, expect } from 'vitest';
import { pumpToolInputStream } from './tool-input-stream.js';

const pump = (input) => {
  const events = [];
  const ctx = { emit: (e) => events.push(e), counters: { turns: 1 }, workspace: null };
  const st = {
    id: 't1', name: 'mcp__nodesign__board_batch', buf: JSON.stringify(input),
    batch: 'write_on_board', field: 'text',
    spot: ['slot', 'at', 'sheet', 'width', 'h', 'near', 'side', 'reply_to', 'chain'],
    lastEmit: 0, sent: 0, actionIdx: -1, spotSent: false, filePathSent: false,
  };
  pumpToolInputStream(ctx, st, true);
  return events[0]?.spot;   // run.delta.tool_input 的 spot 字段
};

describe('freshSheet 预告', () => {
  /**
   * ⛔ 2026-09-01 刀 2：版位退役，`planSlot`（从流进来的 plan 里抠规划矩形）
   * 一并撤了 —— 没有 plan 可抠。剩下的那一半照旧，而且**更要紧了**：
   * 机器现在会自己翻页，前端更需要知道「这条 write 排在一个 open_sheet 后面」。
   */
  it('⭐ write 排在 open_sheet 后面 → spot 标 freshSheet', () => {
    const spot = pump({ actions: [
      { name: 'open_sheet', input: { title: '第二章' } },
      { name: 'write_on_board', input: { chain: true, text: '正文正在流…' } },
    ] });
    expect(spot.freshSheet).toBe(true);
  });

  it('没有 open_sheet 在前 → 不标 freshSheet（当前纸就是目标，别乱预告）', () => {
    const spot = pump({ actions: [
      { name: 'write_on_board', input: { at: { x: 0, y: 0 }, text: '接着写…' } },
    ] });
    expect(spot.freshSheet).toBeUndefined();
  });

  it('⭐ 只看排在自己前面的那几个动作（后面的 open_sheet 不算）', () => {
    const spot = pump({ actions: [
      { name: 'write_on_board', input: { at: { x: 0, y: 0 }, text: '先写…' } },
      { name: 'open_sheet', input: { title: '再开' } },
    ] });
    expect(spot.freshSheet).toBeUndefined();
  });
});
