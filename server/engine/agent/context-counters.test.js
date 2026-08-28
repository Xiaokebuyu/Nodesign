/**
 * 回合计数器的两件事（08-21 夜，fable 评审 P0 + 顺手抓到的生产 bug）：
 *   ① counters 形状只有 freshTurnCounters 一份 —— session-loop 的 startTurn 也用它
 *   ② 半截续接的账要结转（absorbResult 是赋值不是累加，第二个 result 会整个覆盖第一轮）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentContext, freshTurnCounters } from './context.js';
import { EventBus } from './events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mkCtx = () => new AgentContext({ runId: 'run_test_0001', skillId: 's', eventBus: new EventBus() });

describe('freshTurnCounters —— 形状单一真相源', () => {
  it('带 toolCharges（⛔ 少了它 addToolCharge 会 TypeError：generate_image 的钱记不上，成功出的图还会变成工具报错）', () => {
    expect(freshTurnCounters().toolCharges).toEqual({});
  });

  it('新建的 ctx 与 startTurn 重置后的 counters 是同一形状', () => {
    const ctx = mkCtx();
    expect(Object.keys(ctx.counters).sort()).toEqual(Object.keys(freshTurnCounters()).sort());
  });

  it('⛔ session-loop 的 startTurn 必须调 freshTurnCounters，不许自己抄一份字面量', () => {
    const src = fs.readFileSync(path.join(HERE, 'session-loop.js'), 'utf8');
    expect(src).toMatch(/sharedCtx\.counters = freshTurnCounters\(\)/);
    // 抄字面量的形状（`sharedCtx.counters = {`）不该再出现
    expect(src).not.toMatch(/sharedCtx\.counters = \{/);
  });

  it('startTurn 那条路上记按件工具费不炸（真实顺序：startTurn 必定跑在任何工具之前）', () => {
    const ctx = mkCtx();
    ctx.counters = freshTurnCounters();          // = startTurn 干的事
    expect(() => ctx.addToolCharge('generate_image', 0.2)).not.toThrow();
    expect(ctx.counters.toolCharges.generate_image).toBeCloseTo(0.2);
  });
});

describe('takeCarry / addCarry —— 半截续接的账结转', () => {
  const fill = (ctx, n) => {
    ctx.counters.inputTokens = n;
    ctx.counters.outputTokens = n * 2;
    ctx.counters.cacheReadTokens = n * 3;
    ctx.counters.cacheCreateTokens = n * 4;
    ctx.counters.totalCostUsd = n / 100;
    ctx.counters.durationMs = n * 10;
    ctx.counters.durationApiMs = n * 5;
    ctx.counters.modelUsage = { 'glm-5.3-flash-merge': { inputTokens: n, outputTokens: n * 2, cacheReadTokens: n * 3, cacheCreateTokens: n * 4, costUsd: n / 100 } };
  };

  it('结转后是两轮之和（token / cost / 时长）', () => {
    const ctx = mkCtx();
    fill(ctx, 100);
    const carry = ctx.takeCarry();
    fill(ctx, 50);                 // 第二个 result 的 absorbResult：赋值覆盖
    ctx.addCarry(carry);
    expect(ctx.counters.inputTokens).toBe(150);
    expect(ctx.counters.outputTokens).toBe(300);
    expect(ctx.counters.cacheReadTokens).toBe(450);
    expect(ctx.counters.cacheCreateTokens).toBe(600);
    expect(ctx.counters.totalCostUsd).toBeCloseTo(1.5);
    expect(ctx.counters.durationMs).toBe(1500);
    expect(ctx.counters.durationApiMs).toBe(750);
  });

  it('modelUsage 按模型逐项相加（run_model_usage 落库口径，日限闸门读它）', () => {
    const ctx = mkCtx();
    fill(ctx, 100);
    const carry = ctx.takeCarry();
    fill(ctx, 50);
    ctx.addCarry(carry);
    expect(ctx.counters.modelUsage['glm-5.3-flash-merge']).toMatchObject({ inputTokens: 150, outputTokens: 300, costUsd: expect.closeTo(1.5, 5) });
  });

  it('第一轮折进去的按件工具费（generate_image $0.20）不会被第二轮覆盖掉', () => {
    const ctx = mkCtx();
    ctx.counters.modelUsage = { 'glm-5.3-flash-merge': { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 } };
    ctx.addToolCharge('generate_image', 0.2);
    ctx._foldToolCharges();
    expect(ctx.counters.modelUsage.generate_image.costUsd).toBeCloseTo(0.2);
    const carry = ctx.takeCarry();
    // 第二轮：SDK 只报了模型账，charges 表已经在第一轮被清空
    ctx.counters.modelUsage = { 'glm-5.3-flash-merge': { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.01 } };
    ctx.counters.totalCostUsd = 0.01;
    ctx.addCarry(carry);
    expect(ctx.counters.modelUsage.generate_image.costUsd).toBeCloseTo(0.2);
  });

  it('carry 是快照不是引用：存完再改 counters 不影响它', () => {
    const ctx = mkCtx();
    fill(ctx, 100);
    const carry = ctx.takeCarry();
    ctx.counters.modelUsage['glm-5.3-flash-merge'].inputTokens = 999;
    expect(carry.modelUsage['glm-5.3-flash-merge'].inputTokens).toBe(100);
  });

  it('多次续接一路滚下去（carry 存的是「已经含前面所有轮」的当前值）', () => {
    const ctx = mkCtx();
    fill(ctx, 100);
    let carry = ctx.takeCarry();
    fill(ctx, 50); ctx.addCarry(carry);      // 第一次续接后 = 150
    carry = ctx.takeCarry();
    fill(ctx, 20); ctx.addCarry(carry);      // 第二次续接后 = 170
    expect(ctx.counters.inputTokens).toBe(170);
  });

  it('⛔ turns 不结转（SDK 的 num_turns 本身带累计语义，加了会双数）', () => {
    const ctx = mkCtx();
    ctx.counters.turns = 3;
    expect(ctx.takeCarry().turns).toBeUndefined();
  });

  it('addCarry(null) 是 no-op（没续接过的回合照常）', () => {
    const ctx = mkCtx();
    fill(ctx, 100);
    ctx.addCarry(null);
    expect(ctx.counters.inputTokens).toBe(100);
  });
});
