/**
 * model-context 单表真相源测试。重点不是枚举每行，而是钉住派生逻辑与
 * 撞车断言 —— 这张表写错一个字的历史下场是"两处静默降级没人报错"。
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELECTABLE_MODELS,
  resolveSdkSpoofModel,
  resolveModelContextWindow,
  pickThinkingConfig,
  resolveModelRoute,
  resolveWireModel,
  repriceUsageDeltas,
  selectableModelsFor,
  allowedModelsFor, isModelLockedFor, defaultModelFor, modelIsFree, crossLaneSwitchReason, hotSwitchLaneReason, modelSwitchRejection,
  UPSTREAMS, BRANDS, brandOfModel, SHARED_SDK_ALIAS,
} from './model-context.js';
import { MODELS_BUILTIN, SHARED_SDK_ALIAS as SHARED_FROM_TABLE } from './model-table.js';
// 08-30：默认行换成付费行之后，「并发闸把它算在哪一档」成了这张表的一条硬约束（见文末 describe）
import { decideConcurrency } from '../../lib/quota.js';

describe('派生导出（旧签名不变）', () => {
  it('SELECTABLE_MODELS 只暴露带 select 的行；helper 行 / 摘牌行 / 删掉的行都不进 picker', () => {
    const ids = SELECTABLE_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5[1m]');
    expect(ids).toContain('claude-opus-5[1m]');
    // helper 专用行（没写 select）一律不露出 —— 原来这里钉的是"没有任何 kimi"，
    // 08-25 接了 NVIDIA 的 kimi-k3（带闸的可选行）之后那条按名字写的断言就过期了，
    // 改成按**语义**钉：没有 select 的行不进清单
    for (const id of ['deepseek-v4-flash-helper']) expect(ids).not.toContain(id);
    expect(ids).not.toContain('ox-alpha');          // Ox 三行 08-26 随上游下架整族删掉
    expect(resolveWireModel('ox-alpha')).toBe(null);
    expect(resolveWireModel('deepseek-v4-flash-helper')?.appModel).toBe('deepseek-v4-flash-helper');   // 不进 picker ≠ 不在表里
    expect(SELECTABLE_MODELS.find((m) => m.id === 'gemini-3.7-flash')?.gate).toBe('localGen');
    expect(ids).not.toContain('gemini-3.1-pro');     // 3.1 Pro 行 08-21 深夜连同 kimi 行一起删了
    expect(resolveWireModel('gemini-3.1-pro')).toBe(null);
    expect(resolveWireModel('kimi-k2.6')).toBe(null);
    expect(UPSTREAMS.moonshot).toBeUndefined();
    // 08-20 摘牌：盒子关机，行和线路都留着（api 字段仍在），只是不给人选
    expect(ids).not.toContain('qwen3.8-27b');
    expect(resolveWireModel('qwen3.8-27b')?.appModel).toBe('qwen3.8-27b');   // ⭐ 摘牌 ≠ 拆线
    for (const m of SELECTABLE_MODELS) {
      expect(typeof m.label).toBe('string');
      expect(typeof m.desc).toBe('string');
    }
  });

  it('闸门：中转 Gemini 3.7 Flash 只对 admin/获批账号露出，普通账号看不见', () => {
    const plain = selectableModelsFor({ role: 'user' }).map((m) => m.id);
    expect(plain).not.toContain('gemini-3.7-flash');
    expect(plain).toContain('claude-sonnet-5[1m]');          // 无闸门的照常在

    for (const u of [{ role: 'admin' }, { role: 'user', plan: 'pro', allowLocalGen: true }]) {
      const ids = selectableModelsFor(u).map((m) => m.id);
      expect(ids).toContain('gemini-3.7-flash');
      // 摘了牌的行，连 admin 也选不到（gate 是"谁能看见"，select 是"在不在牌上"）
      expect(ids).not.toContain('qwen3.8-27b');
    }
    // 未登录 / 拿不到用户对象时按最严处理
    const anon = selectableModelsFor(null).map((m) => m.id);
    expect(anon).not.toContain('qwen3.8-27b');
    expect(anon).not.toContain('gemini-3.7-flash');
  });

  it('订阅闸（08-21）：没订阅资格的账号看得见 Claude 行但 locked；邀请码号/admin 正常；默认模型=glm-5.3-flash-merge（08-30）', () => {
    const pub = { role: 'user', plan: 'basic' };
    const sub = { role: 'user', plan: 'pro' };
    const pubSel = selectableModelsFor(pub);
    expect(pubSel.find((m) => m.id === 'claude-sonnet-5[1m]')?.locked).toBe(true);
    expect(pubSel.find((m) => m.id === 'minimax-m3')?.locked).toBeUndefined();
    expect(pubSel.find((m) => m.id === 'glm-5.3-flash-merge')?.locked).toBeUndefined();
    expect(allowedModelsFor(pub).map((m) => m.id)).not.toContain('claude-sonnet-5[1m]');
    expect(allowedModelsFor(pub).map((m) => m.id)).toContain('minimax-m3');
    expect(isModelLockedFor(pub, 'claude-opus-5[1m]')).toBe(true);
    expect(isModelLockedFor(sub, 'claude-opus-5[1m]')).toBe(false);
    expect(isModelLockedFor(pub, 'gemini-3.7-flash')).toBe(false);   // 看不见的不是 locked，是不存在
    expect(selectableModelsFor(sub).some((m) => m.locked)).toBe(false);
    expect(selectableModelsFor({ role: 'admin' }).some((m) => m.locked)).toBe(false);
    // 默认行的历任：Ox → minimax-m3（08-26）→ zai 官方直连（08-27）→ **merge 网关（08-30，zai 订阅额度耗尽）**
    for (const u of [pub, sub, { role: 'admin' }, null]) expect(defaultModelFor(u)).toBe('glm-5.3-flash-merge');
    // ⚠️ 「默认行必须免费」那条老规矩 08-30 被用户拍板破了（详见下面那个 describe 的三条新规矩）
    expect(modelIsFree('minimax-m3')).toBe(true);
    expect(modelIsFree('glm-5.3-flash-merge')).toBe(false);   // Merge 网关那条是付费行，走美元日限
    expect(modelIsFree('claude-sonnet-5[1m]')).toBe(false);
    expect(modelIsFree('gemini-3.7-flash')).toBe(false);
    // 会话中途 openai-chat → 别的通路要拦（转换层合成的 thinking 块没 signature，回传会 400）；其它方向放行
    expect(crossLaneSwitchReason('glm-5.3-flash-merge', 'claude-sonnet-5[1m]')).toMatch(/新开一个会话/);
    expect(crossLaneSwitchReason('claude-sonnet-5[1m]', 'glm-5.3-flash-merge')).toBeNull();
    expect(crossLaneSwitchReason('glm-5.3-flash-merge', 'glm-5.3-flash-merge')).toBeNull();
    // 08-25：MiniMax 是 Anthropic 原生透传，从 openai-chat 行切过去同样要拦；反向放行
    expect(crossLaneSwitchReason('glm-5.3-flash-merge', 'minimax-m3')).toMatch(/新开一个会话/);
    expect(crossLaneSwitchReason('glm-5.3-flash-merge', 'minimax-m3')).not.toMatch(/Claude/);   // 话里不许写死"换到 Claude"
    expect(crossLaneSwitchReason('minimax-m3', 'glm-5.3-flash-merge')).toBeNull();
    // 同为 openai-chat 的两行互切不算跨线（原先钉在 Ox 高/深想两行上，08-26 换成 glm ↔ deepseek 视觉）
    expect(crossLaneSwitchReason('glm-5.3-flash-merge', 'deepseek-v4-flash-vision')).toBeNull();
    expect(crossLaneSwitchReason('deepseek-v4-flash-vision', 'claude-opus-5[1m]')).toMatch(/新开一个会话/);
    expect(resolveWireModel('glm-5.3-flash-merge')?.reasoningEffort).toBe('high');
    // ⭐⭐ Merge 网关这行的厂商顺序（08-28 建，08-30 晚定案）。最早钉的是"必须点名 zai 一家"
    // （当时 particle 对多图回 400，已作废、复测 36/36）。现在钉的是用户拍板的口径：
    //   ① **particle 打头** —— 真实体量（28 万上下文、逐轮追加）上它每步 1.8-2.8s，zai 3.9-7.0s，
    //      价钱一模一样。⛔ 别拿 6.5 万去复验，那个体量上两家只差 20%，量不出来。
    //   ② **后面得有人兜底** —— 网关的语义是"按顺序取第一个可用的"，只写一家就没有后备了。
    //   ③ ⛔ **baseten 不许出现**：同一发请求实测 $0.000626，是 particle 的 48 倍、zai 的 11 倍。
    //      它进来不报错，只在月底的账上出现。
    const pool = resolveWireModel('glm-5.3-flash-merge')?.bodyExtra?.vendors;
    const okPool = (v) => Array.isArray(v) && v[0] === 'particle' && v.length >= 2 && !v.includes('baseten');
    expect(okPool(pool), `merge 行的厂商顺序现在是 ${JSON.stringify(pool)}`).toBe(true);
    // 判据先验一遍：四种坏写法都得拦下来，否则上面那条是恒真的
    expect(okPool(['zai', 'particle']), 'zai 打头 = 每步慢 2.5 倍').toBe(false);
    expect(okPool(['particle', 'baseten']), 'baseten 混进来 = 静默贵 48 倍').toBe(false);
    expect(okPool(['particle']), '只剩一家 = 没有后备').toBe(false);
    expect(okPool(undefined), '整个撤掉 = 网关自己挑，实测 20/20 全落慢的那家').toBe(false);
    expect(resolveWireModel('glm-5.3-flash-merge')?.helperReasoningEffort).toBe('low');
  });

  it('⛔ hotSwitchLaneReason：运行中订阅 ↔ API 一律拒（env 在起 query 那刻定死，硬切会拿订阅额度跑 API 模型）', () => {
    // 订阅 → API：binary 没有 ingress 地址，会拿 OAuth 把 alias（真实 Claude 名）打到 anthropic.com = 花真钱
    expect(hotSwitchLaneReason('claude-sonnet-5[1m]', 'glm-5.3-flash-merge')).toMatch(/订阅额度/);
    expect(hotSwitchLaneReason('claude-opus-5[1m]', 'minimax-m3')).toMatch(/新开一个会话/);
    // API → 订阅：那个名字进了入口反查不到，兜底到本会话 fast 行 = 切了没生效
    expect(hotSwitchLaneReason('minimax-m3', 'claude-sonnet-5[1m]')).toMatch(/换不回订阅模型/);
    // 同通路内互切这条闸不管（协议那条闸另外管，两条正交）
    expect(hotSwitchLaneReason('minimax-m3', 'glm-5.3-flash-merge')).toBeNull();
    expect(hotSwitchLaneReason('claude-sonnet-5[1m]', 'claude-opus-5[1m]')).toBeNull();
    expect(hotSwitchLaneReason('glm-5.3-flash-merge', 'glm-5.3-flash-merge')).toBeNull();
    expect(hotSwitchLaneReason(null, 'glm-5.3-flash-merge')).toBeNull();
  });

  it('spoof：API 行给 alias，订阅/未知原样返回', () => {
    expect(resolveSdkSpoofModel('deepseek-v4-flash-vision')).toBe('claude-opus-4-7[1m]');
    expect(resolveSdkSpoofModel('gemini-3.7-flash')).toBe('claude-opus-4-6[1m]');
    expect(resolveSdkSpoofModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5[1m]');
    expect(resolveSdkSpoofModel('made-up-model')).toBe('made-up-model');
    expect(resolveSdkSpoofModel(null)).toBe(null);
  });

  it('window：查表 + pattern fallback + null', () => {
    expect(resolveModelContextWindow('gemini-3.7-flash')).toBe(1_000_000);
    expect(resolveModelContextWindow('deepseek-v4-flash-vision')).toBe(272_000);
    expect(resolveModelContextWindow('claude-sonnet-5')).toBe(200_000);
    expect(resolveModelContextWindow('kimi-future-model')).toBe(256_000);
    expect(resolveModelContextWindow('whatever[1m]')).toBe(1_000_000);
    expect(resolveModelContextWindow('unknown')).toBe(null);
  });

  it('thinking：Sonnet5+/Opus4.6+ adaptive+summarized；API 行 enabled+budget；老模型 enabled', () => {
    expect(pickThinkingConfig('claude-sonnet-5[1m]')).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(pickThinkingConfig('claude-opus-4-7[1m]')).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(pickThinkingConfig('gemini-3.7-flash')).toEqual({ type: 'enabled', budgetTokens: 8192 });
    expect(pickThinkingConfig('deepseek-v4-flash-vision')).toEqual({ type: 'enabled', budgetTokens: 8192 });
    expect(pickThinkingConfig('claude-haiku-4-5')).toEqual({ type: 'enabled', budgetTokens: 8192 });
  });
});

describe('brand（模型出自谁家，08-21）', () => {
  it('每个可选模型都带 brand，且是 BRANDS 之一 —— 前端据此画身份标，漏一个就静默不画图标', () => {
    for (const m of SELECTABLE_MODELS) {
      expect(BRANDS, m.id).toContain(m.brand);
    }
  });

  it('brandOfModel：认识的按表回答，不认识的回 null（调用方自己兜底，不猜）', () => {
    expect(brandOfModel('deepseek-v4-flash-vision')).toBe('deepseek');
    // 08-26：Ox 下架，接替它的 glm 行是**公开身份**的 Z.ai 模型 → 自己的标，不再走供应商方块。
    // 'opencode' 那枚仍在 BRANDS 里留给下一个隐身行（Zen 目录一直有那类行）
    expect(brandOfModel('glm-5.3-flash-merge')).toBe('glm');
    expect(brandOfModel('ox-alpha')).toBeNull();                // 整族删了，查不到就该回 null
    expect(brandOfModel('claude-opus-5[1m]')).toBe('claude');
    expect(brandOfModel('gemini-3.7-flash')).toBe('gemini');
    expect(brandOfModel('没有这个模型')).toBeNull();
    expect(brandOfModel(undefined)).toBeNull();
  });

  it('⚠️ 别拿 sdkAlias 认牌子：DeepSeek 行 spoof 成 Claude 名，照 alias 认会把鲸画成星芒', () => {
    expect(resolveSdkSpoofModel('deepseek-v4-flash-vision')).toMatch(/^claude-/);
    expect(brandOfModel('deepseek-v4-flash-vision')).toBe('deepseek');
    expect(brandOfModel(resolveSdkSpoofModel('deepseek-v4-flash-vision'))).toBe('claude');
  });
});

describe('路由', () => {
  it('订阅模型 → subscription，API 模型带全套路由信息', () => {
    expect(resolveModelRoute('claude-sonnet-5[1m]')).toEqual({ mode: 'subscription' });
    expect(resolveModelRoute(null)).toEqual({ mode: 'subscription' });
    const r = resolveModelRoute('gemini-3.7-flash');
    expect(r.mode).toBe('api');
    expect(r.sdkAlias).toBe('claude-opus-4-6[1m]');
    expect(r.fastModel).toBe('gemini-3.7-flash');
    expect(r.upstream).toBe(UPSTREAMS.lament);
  });

  it('入口反查认三种形态：appModel / alias / 剥[1m]的 alias', () => {
    for (const name of ['gemini-3.7-flash', 'claude-opus-4-6[1m]', 'claude-opus-4-6']) {
      const w = resolveWireModel(name);
      expect(w?.appModel).toBe('gemini-3.7-flash');
      expect(w?.wireModel).toBe('反重力-流式抗截断/gemini-3.7-flash-high');
      expect(w?.liftImages).toBe(true);
    }
    // 订阅名不该被路由（sonnet-5 没有 API 行）
    expect(resolveWireModel('claude-sonnet-5')).toBe(null);
    expect(resolveWireModel(undefined)).toBe(null);
  });

  it('本地 Qwen 行：无鉴权上游、count_tokens 由上游真答', () => {
    const w = resolveWireModel('claude-opus-5');
    expect(w?.appModel).toBe('qwen3.8-27b');
    expect(w?.upstream.authStyle).toBe('none');
    expect(w?.upstream.keyEnv).toBe(null);
    expect(w?.upstream.countTokens).toBe(true);
    expect(resolveModelRoute('qwen3.8-27b').fastModel).toBe('qwen3.8-27b');
  });

  it('⚠️ 每个 API 行的 sdkAlias 容量必须 ≥ 真实 window —— SDK 压缩窗口取二者较小值（自动枚举全表，新行天然被盯上）', () => {
    // 名单 08-26 起是**空的**：唯一的豁免 ox-alpha-helper（故意用 200k 的 haiku 名）随 Ox 整族删了。
    // 想再往里加，先说清楚那一行为什么永远当不了会话主行 —— 只有那样 window 才不会喂进
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW，容量不足才不会变成"压缩窗口悄悄缩水"。
    const HELPER_ONLY_EXEMPT = [];
    for (const m of MODELS_BUILTIN.filter((m) => m.api && !HELPER_ONLY_EXEMPT.includes(m.id))) {
      const r = resolveModelRoute(m.id);
      const aliasWindow = resolveModelContextWindow(r.sdkAlias);
      expect(aliasWindow, `${m.id} 的 alias ${r.sdkAlias} 容量不足`).toBeGreaterThanOrEqual(r.window);
      expect(r.window).toBe(resolveModelContextWindow(m.id));   // route.window 就是表里那个
    }
  });

  it('sdkAlias 可选（08-25 固化）：表里不写 = 派生补共用别名；豁免名单里的行都真在表里', () => {
    // 双名收敛后只剩一个真相源：model-context 的再导出就是 model-table 那一个
    expect(SHARED_SDK_ALIAS).toBe(SHARED_FROM_TABLE);
    // MiniMax 两行在表里不写 sdkAlias（默认写法的样本），派生后拿到的是共用别名
    for (const id of ['minimax-m3', 'kimi-k3', 'deepseek-v4-flash-helper']) {
      expect(MODELS_BUILTIN.find((m) => m.id === id).api.sdkAlias, id).toBeUndefined();
      expect(resolveModelRoute(id).sdkAlias, id).toBe(SHARED_SDK_ALIAS);
      expect(resolveSdkSpoofModel(id), id).toBe(SHARED_SDK_ALIAS);
    }
    // 共用别名的本体必须是表内订阅行（加载断言的前提；window 1M 才配当默认 spoof）
    const sharedRow = MODELS_BUILTIN.find((m) => m.id === SHARED_SDK_ALIAS);
    expect(sharedRow?.api).toBeUndefined();
    expect(sharedRow?.window).toBe(1_000_000);
    // 独占别名的行显式写；独占名全表唯一（撞了在模块加载就炸，这里只对账现状）
    const exclusive = MODELS_BUILTIN.filter((m) => m.api?.sdkAlias && m.api.sdkAlias !== SHARED_SDK_ALIAS);
    const names = exclusive.map((m) => m.api.sdkAlias);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(SHARED_SDK_ALIAS);
  });
});

describe('repriceUsageDeltas', () => {
  const gUsage = { inputTokens: 68_000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.345 };

  it('API 会话：alias 还原成 appModel、按表价重算', () => {
    const out = repriceUsageDeltas({ 'claude-opus-4-6': gUsage }, 'gemini-3.7-flash');
    expect(Object.keys(out)).toEqual(['gemini-3.7-flash']);
    // 68k×$0.75/M + 500×$3.75/M = 0.051 + 0.001875 = 0.052875
    expect(out['gemini-3.7-flash'].costUsd).toBeCloseTo(0.052875, 5);
    expect(out['gemini-3.7-flash'].inputTokens).toBe(68_000);
  });

  it('⚠️ 订阅会话原样返回 —— 真跑 sonnet-4-6 不能被错记成 Gemini 的账', () => {
    const deltas = { 'claude-opus-4-6': gUsage };
    const out = repriceUsageDeltas(deltas, 'claude-sonnet-5[1m]');
    expect(out).toBe(deltas);   // 同一引用，一个字段没动
  });

  it('同一 appModel 的多个 key 形态归并相加', () => {
    const out = repriceUsageDeltas({
      'claude-opus-4-6': { ...gUsage },
      'gemini-3.7-flash': { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 },
    }, 'gemini-3.7-flash');
    expect(out['gemini-3.7-flash'].inputTokens).toBe(69_000);
  });

  it('null / 空对象语义保持（context.js 的 fallback 分支依赖）', () => {
    expect(repriceUsageDeltas(null, 'gemini-3.7-flash')).toBe(null);
    expect(repriceUsageDeltas({}, 'gemini-3.7-flash')).toEqual({});
  });

  // 「没填价的 API 模型 cost 保留 SDK 值」的样本（kimi 行）08-21 深夜随行删除；表里现在每条 API 行都有 prices

  it('本地 Qwen：零价表让 costUsd 归 0（不然按 opus-5 alias 虚价记账）', () => {
    const out = repriceUsageDeltas({
      'claude-opus-5': { inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 3.21 },
    }, 'qwen3.8-27b');
    expect(Object.keys(out)).toEqual(['qwen3.8-27b']);
    expect(out['qwen3.8-27b'].costUsd).toBe(0);
  });

  it('API 会话里不在表里的 key（helper 走 fast 兜底）归到 fastModel、按 fast 价记', () => {
    const out = repriceUsageDeltas({
      'claude-sonnet-5': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 9.99 },
    }, 'gemini-3.7-flash');
    expect(Object.keys(out)).toEqual(['gemini-3.7-flash']);
    expect(out['gemini-3.7-flash'].costUsd).toBeCloseTo(0.75, 4);   // 3.7 flash input $0.75/M，不是 SDK 的 9.99
  });
});

describe('modelSwitchRejection：三条写模型的路共用的那一个判断（08-25 收口）', () => {
  it('协议闸：跑过的 openai-chat 会话换到别的通路要拦；同通路、反向、同模型放行', () => {
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: 'claude-sonnet-5[1m]' })).toMatch(/新开一个会话/);
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: 'minimax-m3' })).toMatch(/新开一个会话/);
    expect(modelSwitchRejection({ from: 'minimax-m3', to: 'glm-5.3-flash-merge' })).toBe(null);
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: 'glm-5.3-flash-merge' })).toBe(null);
  });

  it('⭐没跑过的会话不拦：这条闸防的是历史里没 signature 的 thinking 块，没历史就没这回事', () => {
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: 'claude-sonnet-5[1m]', hasHistory: false })).toBe(null);
    // 但通路闸跟历史无关（env 定死在起 query 那一刻），running 时照拦
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: 'claude-sonnet-5[1m]', hasHistory: false, running: true })).toMatch(/换不回订阅模型/);
  });

  it('通路闸只在 running 时加判：空闲切会重启 query（换的是新 env），不该拦', () => {
    expect(modelSwitchRejection({ from: 'claude-sonnet-5[1m]', to: 'minimax-m3' })).toBe(null);
    expect(modelSwitchRejection({ from: 'claude-sonnet-5[1m]', to: 'minimax-m3', running: true })).toMatch(/订阅额度/);
  });

  it('缺参数一律放行（调用方还没算出 from/to 时不该误伤）', () => {
    expect(modelSwitchRejection({ from: null, to: 'glm-5.3-flash-merge' })).toBe(null);
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: null })).toBe(null);
    expect(modelSwitchRejection({ from: 'glm-5.3-flash-merge', to: undefined, running: true })).toBe(null);
  });

  it('⛔ lint：三条写模型的路只许经这一个函数判，不许自己去调两条底层闸', () => {
    // 08-21 装的协议闸在 sessions.js 和 turn.js 各手写了一份，两份都写错、活了四天没人发现
    // （一份把闸放在写盘之后、拿写完的值当 from；一份多了个 `override &&` 的条件）。
    // 判据放在这里而不是靠注释：注释里的"调用方必须处理 X"拦不住任何人。
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    for (const f of ['server/api/turn.js', 'server/api/sessions.js', 'server/api/turn-model-switch.js']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      expect(src, `${f} 不该直接调底层闸，走 modelSwitchRejection`).not.toMatch(/crossLaneSwitchReason\(|hotSwitchLaneReason\(/);
      expect(src, `${f} 应该调 modelSwitchRejection`).toMatch(/modelSwitchRejection\(/);
    }
  });
});

describe('NVIDIA build · Kimi K3 行（08-25）', () => {
  it('走 nvidia 上游、openai-chat 转换层、思考档 high（上游只认 low|high|max）、helper 特意挪到别家免得抢限流桶', () => {
    const r = resolveModelRoute('kimi-k3');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.nvidia);
    expect(r.upstream.baseUrl).toBe('https://integrate.api.nvidia.com/v1');   // openai-chat 路：baseUrl 带 /v1，入口再接 /chat/completions
    expect(r.upstream.countTokens).toBe(false);   // 没有 count_tokens 端点（404），入口本地估算
    expect(r.window).toBe(272_000);
    expect(r.fastModel).toBe('deepseek-v4-flash-helper');   // 全站共用一把 nvapi 钥匙 = 一个限流桶，helper 不留在这家
    const w = resolveWireModel('kimi-k3');
    expect(w.wireModel).toBe('moonshotai/kimi-k3');
    expect(w.protocol).toBe('openai-chat');
    expect(w.thinking).toBe('strip');
    expect(w.reasoningEffort).toBe('max');   // 08-25 拍板给满：这家限并发不限 token，想多久不额外花钱
    expect(w.helperReasoningEffort).toBe('low');
    // ⛔ medium 上游直接 400（Unsupported Kimi K3 thinking_effort="medium"）—— 改档只能在 low|high|max 里选
    expect(['low', 'high', 'max']).toContain(w.reasoningEffort);
  });

  it('不写 sdkAlias = 走共用别名（08-25 的新默认写法，这一行就是第一个真样本）', () => {
    const raw = MODELS_BUILTIN.find((m) => m.id === 'kimi-k3');
    expect(raw.api.sdkAlias).toBeUndefined();          // 表里一个字没写
    expect(resolveModelRoute('kimi-k3').sdkAlias).toBe(SHARED_SDK_ALIAS);   // 派生时补上
    expect(resolveWireModel(SHARED_SDK_ALIAS)).toBe(null);                  // 仍然不进全表反查
  });

  it('限流大的行先关在闸后：只对 admin/获批露出，普通账号看不见', () => {
    expect(selectableModelsFor({ role: 'user' }).some((m) => m.id === 'kimi-k3')).toBe(false);
    expect(selectableModelsFor({ role: 'admin' }).some((m) => m.id === 'kimi-k3')).toBe(true);
    expect(allowedModelsFor({ role: 'user' }).some((m) => m.id === 'kimi-k3')).toBe(false);
  });
});

describe('GMI Cloud · MiniMax 两行（08-25）—— 共用 sdkAlias 的内置行', () => {
  it('走 gmi 上游、Anthropic 原生透传（不进 openai-chat 转换层）、图不 lift、思考档 adaptive', () => {
    const r = resolveModelRoute('minimax-m3');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.gmi);
    expect(r.upstream.baseUrl).toBe('https://api.gmi-serving.com');   // ⚠️ 不带 /v1：透传路是 baseUrl + 原始路径
    expect(r.upstream.protocol).toBeUndefined();                      // 没有 protocol = 透传 Anthropic
    expect(r.window).toBe(272_000);
    expect(r.fastModel).toBe('deepseek-v4-flash-helper');
    const w = resolveWireModel('minimax-m3');
    expect(w.wireModel).toBe('MiniMaxAI/MiniMax-M3');
    expect(w.thinking).toBe('adaptive');
    expect(w.liftImages).toBe(false);   // 08-25 体检：tool_result 里的图原生直通
    expect(resolveWireModel('deepseek-v4-flash-helper').thinking).toBe('strip');
  });

  it('⭐共用别名**不进全表反查**（分不出是哪一行）—— 没注册会话的请求 502，靠会话级路由认人', () => {
    const alias = resolveModelRoute('minimax-m3').sdkAlias;
    expect(alias).toBe('claude-sonnet-4-6[1m]');
    expect(resolveWireModel(alias)).toBe(null);
    expect(resolveWireModel('claude-sonnet-4-6')).toBe(null);
    // 三行共用同一个别名，各自按 id 可查
    for (const id of ['minimax-m3', 'kimi-k3', 'deepseek-v4-flash-helper']) {
      expect(resolveWireModel(id).appModel, id).toBe(id);
      expect(resolveModelRoute(id).sdkAlias, id).toBe(alias);
    }
  });

  it('⛔ M2.7 撤了（GMI 这家部署把图丢掉，判据见 model-table.js 那段注释）—— 表里和 picker 里都不该有', () => {
    expect(resolveWireModel('minimax-m2.7')).toBe(null);
    expect(SELECTABLE_MODELS.some((m) => m.id === 'minimax-m2.7')).toBe(false);
    // 留下的这一行仍要能画标：picker 里现在只剩 M3 一行 minimax
    expect(SELECTABLE_MODELS.find((m) => m.id === 'minimax-m3').brand).toBe('minimax');
  });

  it('⭐记账按会话优先：共用别名那笔算主行的，不是 fastModel 的（不然计量按模型分组全落到 helper 头上）', () => {
    const usage = { inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 1.23 };
    const out = repriceUsageDeltas({ 'claude-sonnet-4-6[1m]': { ...usage } }, 'minimax-m3');
    expect(Object.keys(out)).toEqual(['minimax-m3']);
    expect(out['minimax-m3'].costUsd).toBe(0);   // 免费部署，零价表
    // helper 请求带的是 app id，照旧按 id 归自己那行
    const out2 = repriceUsageDeltas({ 'deepseek-v4-flash-helper': { ...usage } }, 'minimax-m3');
    expect(Object.keys(out2)).toEqual(['deepseek-v4-flash-helper']);
  });
});

describe('OpenCode Go · DeepSeek V4 Flash Vision 行（08-21 深夜）', () => {
  it('走 zenGo 上游、真名 deepseek-v4-flash-vision-exp、alias opus-4-7[1m]、窗口 272k、helper 是通用 helper 行', () => {
    const r = resolveModelRoute('deepseek-v4-flash-vision');
    expect(r.mode).toBe('api');
    expect(r.upstream).toBe(UPSTREAMS.zenGo);
    expect(r.upstream.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(r.sdkAlias).toBe('claude-opus-4-7[1m]');   // kimi 退役腾出的 1M 名；窗口用户拍板 272k
    expect(r.window).toBe(272_000);
    expect(resolveModelContextWindow(r.sdkAlias)).toBeGreaterThanOrEqual(r.window);
    expect(r.fastModel).toBe('deepseek-v4-flash-helper');   // 08-26 从 ox-alpha-helper 改过来（Ox 整族下架，那条 helper 的失效不出声）
    expect(resolveWireModel('claude-opus-4-7')?.wireModel).toBe('deepseek-v4-flash-vision-exp');
    expect(resolveWireModel('claude-opus-4-5')).toBe(null);   // 那个 200k 空名没再占
    expect(resolveWireModel('claude-sonnet-4-6[1m]')).toBe(null);   // 3.1-pro 退役腾出的名 = 现在的共用别名，不进全表反查
    expect(resolveWireModel('claude-sonnet-5')).toBe(null);   // 订阅默认名仍不可路由
    // 08-21 深夜开闸给所有档（basic 靠 $5/天日限管着）
    expect(SELECTABLE_MODELS.find((m) => m.id === 'deepseek-v4-flash-vision')?.gate).toBeUndefined();
    for (const u of [{ role: 'user', plan: 'basic' }, { role: 'user', plan: 'pro' }, { role: 'admin' }]) {
      expect(allowedModelsFor(u).map((m) => m.id)).toContain('deepseek-v4-flash-vision');
    }
    expect(modelIsFree('deepseek-v4-flash-vision')).toBe(false);   // 付费行：走 checkQuota 的美元日限，不走免费轮次闸
    // 08-27 接替 zenGo 那条 glm 的 merge 网关行：上游真名带 vendor 前缀，共用别名（没写 sdkAlias）
    const g = resolveModelRoute('glm-5.3-flash-merge');
    expect(g.upstream).toBe(UPSTREAMS.merge);
    expect(g.sdkAlias).toBe(SHARED_SDK_ALIAS);
    expect(g.window).toBe(1_000_000);   // 08-30 用户拍板 GLM 两行一起开到 1M
    expect(resolveWireModel('glm-5.3-flash-merge')?.wireModel).toBe('zai/glm-5.3-flash');
    expect(resolveWireModel('glm-5.3-flash-merge')?.protocol).toBe('openai-chat');
    expect(modelIsFree('glm-5.3-flash-merge')).toBe(false);
    // ⛔ 下架的名字一个都不许还查得到（留着 = 请求带着别人的钥匙打一个 401 的真名）
    // 08-27 起 glm-5.3-flash（/zen/go 那条）也在这份名单里：撤行不删干净 = 老会话拿着它继续路由
    for (const id of ['ox-alpha', 'ox-alpha-max', 'ox-alpha-helper', 'glm-5.3-flash']) {
      expect(resolveWireModel(id), id).toBe(null);
      expect(resolveModelRoute(id).mode, id).toBe('subscription');   // 不认识的名字退回订阅通路，不瞎猜
    }
  });
});

describe('加载期断言真的会炸（换一张毒表 import 一遍 —— 装了闸就攻一遍，不许只靠代码里写着）', () => {
  const importWithTable = async (mutate) => {
    vi.resetModules();
    const real = await vi.importActual('./model-table.js');
    vi.doMock('./model-table.js', () => ({ ...real, MODELS_BUILTIN: Object.freeze(mutate([...real.MODELS_BUILTIN])) }));
    try {
      return await import('./model-context.js');
    } finally {
      vi.doUnmock('./model-table.js');
      vi.resetModules();
    }
  };

  it('独占 sdkAlias 撞车（第二行显式抢同一个名）→ import 当场 throw，不静默', async () => {
    await expect(importWithTable((rows) => [...rows, {
      id: 'evil-twin', window: 1_000_000, brand: 'custom',
      api: { upstream: 'gmi', wireModel: 'x', sdkAlias: 'claude-opus-4-6[1m]', fastModel: 'evil-twin' },
    }])).rejects.toThrow(/撞车/);
  });

  it('共用别名的本体订阅行被删 → import 当场 throw（哪怕没有任何行在用它，默认值也必须始终有效）', async () => {
    await expect(importWithTable((rows) => rows.filter((m) => m.id !== 'claude-sonnet-4-6[1m]')))
      .rejects.toThrow(/SHARED_SDK_ALIAS/);
  });

  it('对照组：原表原样 import 不炸（证明上面俩不是 import 本身就坏）', async () => {
    const mc = await importWithTable((rows) => rows);
    expect(mc.resolveModelRoute('minimax-m3').sdkAlias).toBe(SHARED_SDK_ALIAS);
  });
});

describe('⛔ glm-5.3-flash-zai 已下架（2026-08-30，包月订阅额度耗尽）', () => {
  it('⭐⭐ 行和上游都不许还查得到 —— 留着 = 请求带着一把废钥匙去打一个 401 的真名', () => {
    expect(resolveWireModel('glm-5.3-flash-zai')).toBeNull();
    expect(resolveModelRoute('glm-5.3-flash-zai').mode).toBe('subscription');   // 不认识的名字退回订阅通路，不瞎猜
    expect(SELECTABLE_MODELS.find((m) => m.id === 'glm-5.3-flash-zai')).toBeUndefined();
    expect(UPSTREAMS.zai, '上游只有它一行在用，行走了上游也要走').toBeUndefined();
  });

  it('⭐ 撤行三查（Ox 那次栽过的三个坑，逐条钉住）', () => {
    // ① 没有别的行的 fastModel 指着它 —— 指着一个不存在的行不会报错，只会静默失效
    for (const m of SELECTABLE_MODELS) {
      const fm = resolveModelRoute(m.id)?.fastModel;
      expect(fm, `${m.id} 的 fastModel 指着下架的行`).not.toBe('glm-5.3-flash-zai');
      if (fm) expect(resolveWireModel(fm), `${m.id} 的 fastModel「${fm}」查不到`).toBeTruthy();
    }
    // ② 没有别的行还挂在 zai 上游上
    for (const m of SELECTABLE_MODELS) expect(resolveModelRoute(m.id)?.upstreamId).not.toBe('zai');
    // ③ default 已经挪走（这是撤行当天最容易漏的一步：不挪的话新会话第一轮落在不存在的行上）
    expect(defaultModelFor(null)).not.toBe('glm-5.3-flash-zai');
    expect(resolveWireModel(defaultModelFor(null)), '默认行必须查得到').toBeTruthy();
  });
});

describe('全员默认行 = glm-5.3-flash-merge（2026-08-30 起，第一条付费的默认行）', () => {
  it('⭐⭐ 默认行对每一档都是同一个、而且 basic 真的选得到（否则公开注册第一轮就 403）', () => {
    for (const u of [{ role: 'user', plan: 'basic' }, { role: 'user', plan: 'pro' }, { role: 'admin' }, null]) {
      expect(defaultModelFor(u)).toBe('glm-5.3-flash-merge');
    }
    expect(allowedModelsFor({ role: 'user', plan: 'basic' }).map((m) => m.id)).toContain('glm-5.3-flash-merge');
    expect(SELECTABLE_MODELS.find((m) => m.id === 'glm-5.3-flash-merge')?.gate).toBeUndefined();
  });

  it('⭐⭐ 默认行不再是免费行 —— 旧规矩换成新规矩，别只是把断言删了', () => {
    // 08-26/27 两次挪默认时，这里钉的是「默认行必须四价全 0」，它把人绊住过两次。
    // 08-30 用户拍板「默认丢到 merge 那边」，那条规矩是**故意破的**，所以换成现在真正在管事的两条：
    expect(modelIsFree('glm-5.3-flash-merge'), '它确实是付费行，走美元日限不走免费轮次闸').toBe(false);
    // ① 付费的默认行必须是**所有人都选得到的那些行里最便宜的一条**：默认可以收费，但不许悄悄变贵。
    // ⚠️ 价格真身在 MODELS_BUILTIN 的 api.prices —— resolveWireModel 不带 prices 出来。
    // 第一版这条断言就是问它要的，于是拿 undefined 一路比成 Infinity、退化成"表里第一条付费行"，
    // 红了才发现（红得对，但理由是假的）。判据本身要先验一遍，这是第 n 次。
    const openPaid = MODELS_BUILTIN.filter((m) => m.select && !m.select.gate && m.api?.prices
      && (m.api.prices.input + m.api.prices.output) > 0);
    const sum = (m) => m.api.prices.input + m.api.prices.output;
    expect(openPaid.length, '一条不带闸的付费行都没有 = 这条断言在空转').toBeGreaterThan(1);
    const cheapest = [...openPaid].sort((a, b) => sum(a) - sum(b))[0];
    expect(cheapest.id, '默认行是付费行时必须是最便宜的那条').toBe('glm-5.3-flash-merge');
    // 对照：确实有更贵的行存在，排序不是在一个元素上做的
    expect(sum([...openPaid].sort((a, b) => sum(b) - sum(a))[0])).toBeGreaterThan(sum(cheapest));
    // ② 还留着一条真免费的行可选（默认收费了，picker 里不能一条免费的都没有）
    expect(SELECTABLE_MODELS.some((m) => modelIsFree(m.id) && !m.gate), '一条不带闸的免费行都没有了').toBe(true);
  });

  it('⭐⭐ 并发闸必须把它算成"非订阅"：算成订阅那一档的话全站默认路径从 12 掉到 3', () => {
    // 这条是 08-30 换默认时真踩到的：checkConcurrency 原来按"免费/付费"分档，
    // 而 .env 里 NODESIGN_MAX_CONCURRENT_RUNS=3（那个 3 护的是站主的 Claude 订阅）。
    // 实测峰值在飞 turn 是 4 —— 判据不改的话第 4 个人当场吃「现在有点挤」。
    expect(resolveModelRoute('glm-5.3-flash-merge').mode).toBe('api');
    const env = { NODESIGN_MAX_CONCURRENT_RUNS: '3', NODESIGN_FREE_MAX_CONCURRENT_RUNS: '12', NODESIGN_USER_CONCURRENT_RUNS: '99' };
    const at = (n, offSubscription) => decideConcurrency({ running: n, mine: 0, isAdmin: false, offSubscription, memMb: 4000, env });
    expect(at(4, true).ok, '非订阅行 4 个在飞应当照放').toBe(true);
    expect(at(4, false).ok, '订阅那一档 4 个在飞就该拦 —— 对照组，证明这个断言不是恒真').toBe(false);
    expect(at(12, true).ok, '非订阅行也有防失控上限 12').toBe(false);
  });
});
