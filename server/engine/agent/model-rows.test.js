/** relay 目录 → 表行（09-11）：纯函数，不起 profile、不碰模块状态。整合进 model-context 的那一半在 model-source.test.js。 */
import { describe, it, expect } from 'vitest';
import { mergeRelayRows, withDefaultAlias } from './model-rows.js';
import { MODELS_BUILTIN, UPSTREAMS_BUILTIN, SHARED_SDK_ALIAS } from './model-table.js';

const BASE = MODELS_BUILTIN.map(withDefaultAlias);
const noKeys = { keyPresent: () => false };
const VISION = 'deepseek-v4-flash-vision';   // 内置 API 行（zenGo）
const HELPER = 'deepseek-v4-flash-helper';
const api = (id, extra = {}) => ({ id, locked: false, mode: 'api', label: `L-${id}`, desc: 'd', brand: 'deepseek', window: 500_000, sdkAlias: SHARED_SDK_ALIAS, fastModel: HELPER, protocol: 'openai-chat', prices: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, ...extra });
const cat = (models, renames = {}) => ({ ok: true, models, renames });
const merge = (catalog, opts = noKeys, base = BASE) => mergeRelayRows(base, UPSTREAMS_BUILTIN, catalog, opts);

describe('mergeRelayRows', () => {
  it('目录没拉到 / 老站点（条目没有 mode）→ 表原样返回，一行都不生成', () => {
    expect(merge({ ok: false, models: [api('x')] }).models).toBe(BASE);
    const old = merge(cat([{ id: VISION, locked: false }, { id: 'brand-new', locked: false }]));
    expect(old.models).toBe(BASE);
    expect(old.upstreams).toBe(UPSTREAMS_BUILTIN);
  });

  it('本地表里没有的行：照目录建出来，排在最后；上游是按协议合成的 relay 上游（没钥匙）', () => {
    const r = merge(cat([api('brand-new')]));
    const row = r.models.at(-1);
    expect(row).toMatchObject({ id: 'brand-new', window: 500_000, brand: 'deepseek', relay: true, select: { label: 'L-brand-new', desc: 'd' } });
    expect(row.api).toMatchObject({ upstream: 'relay:openai-chat', sdkAlias: SHARED_SDK_ALIAS, fastModel: HELPER, thinking: 'strip', prices: { input: 1, output: 2 } });
    expect(r.upstreams['relay:openai-chat']).toMatchObject({ protocol: 'openai-chat', key: null, keyEnv: null });
    expect(r.models).toHaveLength(BASE.length + 1);
  });

  it('本机没钥匙的内置行：被目录那份**原位**顶替（名字、窗口、别名都跟站点走），选择器顺序不乱', () => {
    const idx = BASE.findIndex((m) => m.id === VISION);
    const r = merge(cat([api(VISION, { label: 'DeepSeek V4.1 Flash · OpenCode Go', window: 272_000, sdkAlias: 'claude-opus-4-7[1m]' })]));
    expect(r.models[idx]).toMatchObject({ id: VISION, relay: true, select: { label: 'DeepSeek V4.1 Flash · OpenCode Go' } });
    expect(r.models[idx].api.sdkAlias).toBe('claude-opus-4-7[1m]');
    expect(r.models).toHaveLength(BASE.length);
  });

  it('本机优先：有钥匙的内置行、用户插槽、订阅 Claude 行都不被顶替', () => {
    const keyed = merge(cat([api(VISION)]), { keyPresent: (row) => row.id === VISION });
    expect(keyed.models.find((m) => m.id === VISION)).toBe(BASE.find((m) => m.id === VISION));
    const slot = Object.freeze({ id: 'mine', window: 100_000, brand: 'custom', external: true, select: { label: 'mine', desc: '' }, api: { upstream: 'x', wireModel: 'w', sdkAlias: SHARED_SDK_ALIAS, fastModel: 'mine' } });
    const withSlot = merge(cat([api('mine')]), noKeys, [...BASE, slot]);
    expect(withSlot.models.find((m) => m.id === 'mine')).toBe(slot);
    const sub = merge(cat([{ id: 'claude-sonnet-5[1m]', locked: true, mode: 'subscription', label: 'Sonnet 5' }]));
    expect(sub.models.find((m) => m.id === 'claude-sonnet-5[1m]')).toBe(BASE.find((m) => m.id === 'claude-sonnet-5[1m]'));
  });

  it('⛔ sdkAlias 本地表里没有 → 这行不建（不许退回共用别名：站点会把主回合改道成 helper），报出来', () => {
    const r = merge(cat([api('odd', { sdkAlias: 'claude-future-9[1m]' })]));
    expect(r.models.some((m) => m.id === 'odd')).toBe(false);
    expect(r.errors[0].message).toContain('claude-future-9[1m]');
    // 别名指向本地的 API 行也不行（必须是订阅 Claude 名）
    expect(merge(cat([api('odd2', { sdkAlias: VISION })])).models.some((m) => m.id === 'odd2')).toBe(false);
  });

  it('不认识的牌子落 custom（前端有通用标）；window 不对的不建', () => {
    expect(merge(cat([api('b', { brand: 'nextco' })])).models.at(-1).brand).toBe('custom');
    expect(merge(cat([api('w', { window: 'big' })])).models.some((m) => m.id === 'w')).toBe(false);
  });

  it('helper：目录里一起下发的 helper 条目不进选择器；fastModel 在表里找不到就指自己', () => {
    const r = merge(cat([api('main-a', { fastModel: 'new-helper' }), api('new-helper', { helper: true, label: undefined })]));
    expect(r.models.find((m) => m.id === 'main-a').api.fastModel).toBe('new-helper');
    expect(r.models.find((m) => m.id === 'new-helper').select).toBeUndefined();
    const lone = merge(cat([api('main-b', { fastModel: 'ghost' })]));
    expect(lone.models.find((m) => m.id === 'main-b').api.fastModel).toBe('main-b');
  });

  it('选择器字段跟着走：only / stageDefault / default / 钟点闸时段', () => {
    const hours = { why: '高峰', tz: 'UTC', windows: ['01:00-04:00'] };
    const row = merge(cat([api('s', { only: 'stage', stageDefault: true, default: true, unavailable: hours })])).models.at(-1);
    expect(row.select).toMatchObject({ only: 'stage', stageDefault: true, default: true });
    expect(row.unavailable).toEqual(hours);
  });

  it('站点改过名：本地那条旧 id 的内置行（没钥匙、目录里没有）退出表，存量旧 id 才翻得过去；有钥匙的留着', () => {
    const renames = { [VISION]: 'dsv41-go' };
    const r = merge(cat([api('dsv41-go')], renames));
    expect(r.models.some((m) => m.id === VISION)).toBe(false);
    expect(r.renames).toEqual(renames);
    const keyed = merge(cat([api('dsv41-go')], renames), { keyPresent: (row) => row.id === VISION });
    expect(keyed.models.some((m) => m.id === VISION)).toBe(true);
    // 改名目标不在表里（这个账号看不见那行）：旧行不动
    expect(merge(cat([api('other')], renames)).models.some((m) => m.id === VISION)).toBe(true);
  });
});
