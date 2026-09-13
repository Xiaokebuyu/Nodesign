import { describe, it, expect } from 'vitest';
import { effortChoicesFor, clampEffort, defaultEffortFor, sdkEffortFor, wireReasoningEffort, EFFORT_LEVELS, FIXED_ROW_SDK_EFFORT } from './model-effort.js';
import { MODEL_ROWS, resolveWireModel, selectableModelsFor, effortForModel } from './model-context.js';

const row = (id) => MODEL_ROWS.find((r) => r.id === id);

describe('model-effort 纯函数', () => {
  it('订阅行：Sonnet 5 / Opus 5（含 1M 名）五档可调，其余订阅行不可调', () => {
    expect(effortChoicesFor({ id: 'claude-sonnet-5[1m]' })).toEqual(EFFORT_LEVELS);
    expect(effortChoicesFor({ id: 'claude-opus-5' })).toEqual(EFFORT_LEVELS);
    expect(effortChoicesFor({ id: 'claude-haiku-4-5' })).toBeNull();
  });
  it('API 行：只有写了 api.efforts 的可调，按从低到高排、丢掉非法值；只剩一档也算不可调', () => {
    expect(effortChoicesFor({ id: 'x', api: { efforts: ['max', 'low', 'bogus', 'high'] } })).toEqual(['low', 'high', 'max']);
    expect(effortChoicesFor({ id: 'x', api: { reasoningEffort: 'high' } })).toBeNull();
    expect(effortChoicesFor({ id: 'x', api: { efforts: ['high'] } })).toBeNull();
  });
  it('就近换算：有就用；没有取不高于它的最高档；都更高取最低档', () => {
    const zen = ['low', 'high', 'max'];
    expect(clampEffort('high', zen)).toBe('high');
    expect(clampEffort('medium', zen)).toBe('low');
    expect(clampEffort('xhigh', zen)).toBe('high');
    expect(clampEffort('low', ['high', 'max'])).toBe('high');
    expect(clampEffort('nope', zen)).toBeNull();
    expect(clampEffort('high', null)).toBeNull();
  });
  it('默认档：订阅行 medium；API 行 = 行内 reasoningEffort 换算', () => {
    expect(defaultEffortFor({ id: 'claude-opus-5[1m]' })).toBe('medium');
    expect(defaultEffortFor({ id: 'x', api: { efforts: ['low', 'high', 'max'], reasoningEffort: 'high' } })).toBe('high');
  });
  it('起会话传给 SDK：选过→换算；没选过→行默认；不可调→固定 medium（跟 09-13 之前一致）', () => {
    const zenRow = { id: 'x', api: { efforts: ['low', 'high', 'max'], reasoningEffort: 'high' } };
    expect(sdkEffortFor(zenRow, 'medium')).toBe('low');
    expect(sdkEffortFor(zenRow, null)).toBe('high');
    expect(sdkEffortFor({ id: 'x', api: { reasoningEffort: 'high' } }, 'max')).toBe(FIXED_ROW_SDK_EFFORT);
  });
  it('ingress：可调行按请求体 effort 换算；不可调或没带 → 行内 reasoningEffort（跟以前一样）', () => {
    const wire = { reasoningEffort: 'high', efforts: ['low', 'high', 'max'] };
    expect(wireReasoningEffort(wire, { output_config: { effort: 'max' } })).toBe('max');
    expect(wireReasoningEffort(wire, { output_config: { effort: 'medium' } })).toBe('low');
    expect(wireReasoningEffort(wire, {})).toBe('high');
    expect(wireReasoningEffort({ reasoningEffort: 'high', efforts: null }, { output_config: { effort: 'low' } })).toBe('high');
  });
});

describe('真表对账', () => {
  it('写了 efforts 的 API 行都是 openai-chat 协议（请求体 effort 只在转换层被换算），且默认档在可选档里', () => {
    const tunable = MODEL_ROWS.filter((r) => r.api && effortChoicesFor(r));
    expect(tunable.length).toBeGreaterThan(0);   // 判据自检
    for (const r of tunable) {
      expect(resolveWireModel(r.id)?.protocol, `${r.id} 不是 openai-chat，effort 不会被换算`).toBe('openai-chat');
      expect(effortChoicesFor(r)).toContain(defaultEffortFor(r));
      expect(resolveWireModel(r.id).efforts).toEqual(effortChoicesFor(r));
    }
  });
  it('⭐ 可调 API 行的默认档 = 以前的行内 reasoningEffort：不选的用户上线前后打上游的档位不变', () => {
    for (const r of MODEL_ROWS.filter((x) => x.api && effortChoicesFor(x))) {
      expect(sdkEffortFor(r, null), r.id).toBe(r.api.reasoningEffort);
      expect(wireReasoningEffort(resolveWireModel(r.id), { output_config: { effort: sdkEffortFor(r, null) } }), r.id).toBe(r.api.reasoningEffort);
    }
  });
  it('选择器清单带 efforts / defaultEffort（可调的行才带）；effortForModel 认得 appModel', () => {
    const opts = selectableModelsFor({ role: 'admin', tier: 'pro' });
    const sonnet = opts.find((o) => o.id === 'claude-sonnet-5[1m]');
    if (sonnet) expect(sonnet).toMatchObject({ efforts: EFFORT_LEVELS, defaultEffort: 'medium' });
    expect(opts.some((o) => Array.isArray(o.efforts))).toBe(true);
    expect(effortForModel('claude-opus-5[1m]', 'xhigh')).toEqual({ choices: EFFORT_LEVELS, sdk: 'xhigh' });
    expect(row('claude-opus-5[1m]')).toBeTruthy();
  });
});
