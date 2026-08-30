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
  it('⭐ write 排在 open_sheet 后面 → spot 带 freshSheet + planSlot（从流进来的 plan 里抠）', () => {
    const spot = pump({ actions: [
      { name: 'open_sheet', input: { title: '第二章', plan: [
        { slot: 'main', at: { x: 0, y: 0 }, w: 648, h: 880 },
        { slot: 'side', at: { x: 700, y: 0 }, w: 600, h: 880 },
      ] } },
      { name: 'write_on_board', input: { slot: 'side', chain: true, text: '正文正在流…' } },
    ] });
    expect(spot.freshSheet).toBe(true);
    expect(spot.planSlot).toEqual({ x: 700, y: 0, w: 600, h: 880 });
  });

  it('没有 open_sheet 在前 → 不标 freshSheet（当前纸就是目标，别乱预告）', () => {
    const spot = pump({ actions: [
      { name: 'write_on_board', input: { slot: 'main', text: '接着写…' } },
    ] });
    expect(spot.freshSheet).toBeUndefined();
  });

  it('plan 还没流完（slot 缺 w/h）→ 只标 freshSheet，不给半截矩形', () => {
    const spot = pump({ actions: [
      { name: 'open_sheet', input: { plan: [{ slot: 'main', at: { x: 0, y: 0 }, w: 648 }] } },
      { name: 'write_on_board', input: { slot: 'main', text: 'x' } },
    ] });
    expect(spot.freshSheet).toBe(true);
    expect(spot.planSlot).toBeUndefined();
  });
});
