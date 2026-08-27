import { describe, it, expect } from 'vitest';
import { UpstreamBilling, upstreamCostOf } from './upstream-billing.js';

describe('UpstreamBilling', () => {
  it('按会话×模型累加 cost 与 usage；take 取走清零；没报 cost 且没 usage 不记', () => {
    const b = new UpstreamBilling();
    b.note('s1', 'glm-5.3-flash-merge', { costUsd: '0.001', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 5 } } });
    b.note('s1', 'glm-5.3-flash-merge', { costUsd: 0.002, usage: { prompt_tokens: 50, completion_tokens: 10 } });
    b.note('s1', 'deepseek-v4-flash-helper', { costUsd: '0', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    b.note('s1', 'glm-5.3-flash-merge', {});                                   // 空 → 不记
    b.note('s2', 'glm-5.3-flash-merge', { costUsd: null, usage: { prompt_tokens: 1 } });   // 没 cost 但有 usage → 记 usage，cost 保持 null
    const t = b.take('s1');
    expect(t['glm-5.3-flash-merge']).toMatchObject({ responses: 2, promptTokens: 150, completionTokens: 30, cachedTokens: 64, reasoningTokens: 5 });
    expect(t['glm-5.3-flash-merge'].costUsd).toBeCloseTo(0.003, 9);
    expect(t['deepseek-v4-flash-helper']).toMatchObject({ responses: 1, costUsd: 0 });
    expect(b.take('s1')).toBeNull();
    expect(b.peek('s2')['glm-5.3-flash-merge'].costUsd).toBeNull();
    expect(b.take('nope')).toBeNull();
  });
});

describe('upstreamCostOf', () => {
  it('顶层 cost（Zen）与 usage.cost（Merge 网关）都认，顶层优先；缺席/非数 → null', () => {
    expect(upstreamCostOf({ cost: '0.0042' })).toBe(0.0042);                       // Zen：字符串也收
    expect(upstreamCostOf({ usage: { prompt_tokens: 9, cost: 1.006e-5 } })).toBe(1.006e-5);   // Merge：钱在 usage 里
    expect(upstreamCostOf({ cost: 0.5, usage: { cost: 0.9 } })).toBe(0.5);         // 两处都有 → 顶层赢
    expect(upstreamCostOf({ usage: { prompt_tokens: 9 } })).toBeNull();            // 只有 usage 没 cost
    expect(upstreamCostOf({ cost: 'free' })).toBeNull();                           // 非数不许当 0：假数据比没有更坏
    expect(upstreamCostOf(null)).toBeNull();
  });
});
