/**
 * 外审档两旋钮（2026-08-20）：订阅模型看 moderationLevel，本地/中转（API 行）看
 * moderationLevelApi。钉住的是"按模型通路取旋钮"这件事 ——
 * 站主给朋友开 qwen 无审查不该顺带放开 Sonnet，反之亦然。
 *
 * ⭐ 08-30 起**两边的默认档也各算各的**（订阅 strict / API off，见 auth/tier.js）。
 * 在此之前两个旋钮共用一个默认值，于是"订阅严、其他放开"这个口径只能靠逐人钉 ——
 * 库里 88 个号钉过 41 个，钉漏的还在按 strict 跑。下面那条 describe 里的每一句
 * 都先造了一个"把两栏合回一栏就会红"的局面。
 */
import { describe, it, expect } from 'vitest';
import { levelFor, moderationKnobFor } from './moderation.js';

const SUB = 'claude-sonnet-5[1m]';
const QWEN = 'qwen3.8-27b';
const GEMINI = 'gemini-3.7-flash';   // 3.1-pro 行 08-21 深夜清掉，换同通路的 3.7 Flash 当 API 样本
const user = (o = {}) => ({ id: 'u1', role: 'user', plan: 'pro', lifetimeCostLimitUsd: null, moderationLevel: null, moderationLevelApi: null, ...o });

describe('moderationKnobFor', () => {
  it('订阅行 / 未知名 / 空 → subscription；API 行 → api', () => {
    expect(moderationKnobFor(SUB)).toBe('subscription');
    expect(moderationKnobFor('claude-opus-5')).toBe('subscription');
    expect(moderationKnobFor('typo-model')).toBe('subscription');
    expect(moderationKnobFor(null)).toBe('subscription');
    expect(moderationKnobFor(QWEN)).toBe('api');
    expect(moderationKnobFor(GEMINI)).toBe('api');
  });
});

describe('levelFor(user, appModel)', () => {
  it('订阅旋钮显式钉 strict、API 旋钮没设：Sonnet 照严，qwen/gemini 仍走 API 那栏的默认 off', () => {
    // 08-30 前这条测的是反方向（订阅钉 off、API 走默认 strict）。API 默认改成 off 之后
    // 那个方向证不出独立性了（两边都 off，合成一栏也过），所以换成这个方向：
    // 一栏钉紧、另一栏不受牵连。
    const u = user({ moderationLevel: 'strict' });
    expect(levelFor(u, SUB)).toBe('strict');
    expect(levelFor(u, QWEN)).toBe('off');
    expect(levelFor(u, GEMINI)).toBe('off');
  });
  it('API 旋钮显式 off、订阅没设：qwen/gemini 关审，Sonnet 仍 strict —— 给朋友开 qwen 不放开 Sonnet', () => {
    const u = user({ moderationLevelApi: 'off' });
    expect(levelFor(u, QWEN)).toBe('off');
    expect(levelFor(u, GEMINI)).toBe('off');
    expect(levelFor(u, SUB)).toBe('strict');
  });
  it('两边都显式设、互不牵连', () => {
    const u = user({ moderationLevel: 'strict', moderationLevelApi: 'off' });
    expect(levelFor(u, SUB)).toBe('strict');
    expect(levelFor(u, QWEN)).toBe('off');
  });
  it('⭐⭐ 默认档按通路各算各的（08-30）：一个号什么都没钉，订阅 strict / 非订阅 off', () => {
    // 同一个 user 对象、同一次调用，只换模型名 —— 两栏合回一栏的话这一条必红
    for (const u of [user(), user({ plan: 'basic' }), user({ lifetimeCostLimitUsd: 5 })]) {
      expect(levelFor(u, SUB)).toBe('strict');       // 订阅骑的是站主账号，照严
      expect(levelFor(u, QWEN)).toBe('off');         // 各家 API 有自己的内容策略，不再叠一层
      expect(levelFor(u, GEMINI)).toBe('off');
    }
    // admin 两边都免审（这一条在拆分前后都成立，留着当对照：不是"API 那栏恒 off"就完事）
    expect(levelFor(user({ role: 'admin' }), SUB)).toBe('off');
    expect(levelFor(user({ role: 'admin' }), QWEN)).toBe('off');
  });
  it('显式钉过的档仍然压过默认（改默认不该动已经钉过的号）', () => {
    expect(levelFor(user({ moderationLevelApi: 'strict' }), QWEN)).toBe('strict');
    expect(levelFor(user({ moderationLevelApi: 'loose' }), QWEN)).toBe('loose');
    expect(levelFor(user({ moderationLevel: 'off' }), SUB)).toBe('off');
  });
  it('不给模型 = 订阅旋钮（老签名兼容）；拼错的档位值当没设', () => {
    expect(levelFor(user({ moderationLevel: 'off', moderationLevelApi: 'strict' }))).toBe('off');
    expect(levelFor(user({ moderationLevelApi: 'nope' }), QWEN)).toBe('off');   // 拼错 → 回默认（API 那栏 = off）
    expect(levelFor(user({ moderationLevel: 'nope' }), SUB)).toBe('strict');    // 订阅那栏拼错 → 回 strict，落紧的一边
    expect(levelFor(null, QWEN)).toBe('off');
  });
});
