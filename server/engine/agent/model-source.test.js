/** 本地分发版选择器的第三条来源：本机没钥匙的行看 relay 目录；本机有钥匙的行永远走本机。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'model-source-data-'));
delete process.env.ANTHROPIC_API_KEY;
process.env.NODESIGN_CONFIG_DIR = '/nonexistent-claude-config-dir';   // 让 claudeAuthPresent() 为 null……
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'model-source-home-'));                                  // ……它还会翻 ~/.claude.json 的 oauthAccount，这台机器上有
// ⚠️ 全部动态 import：静态 import 会被提升到上面那几行 env 之前执行，profile.js 就会读成 hosted
const rc = await import('../../runtime/relay-client.js');
const mc = await import('./model-context.js');
const { LOCAL_OWNER } = await import('../../auth/users-store.js');

// 挑一条上游要钥匙的 API 行（authStyle 'none' 的本地盒子行永远算"本机有钥匙"，不适合这组判据）
const apiRow = mc.SELECTABLE_MODELS.find((m) => mc.resolveModelRoute(m.id).mode === 'api' && !m.only && mc.resolveWireModel(m.id)?.upstream?.keyEnv);
const keyEnvOf = (id) => mc.resolveWireModel(id)?.upstream?.keyEnv;

describe('modelSourceFor（local profile）', () => {
  it('目录空：本机没钥匙的行 → null，选择器不列', () => {
    rc._setRelayCatalog({ configured: false, ok: false, at: 0, error: null, whoami: null, models: [] });
    delete process.env[keyEnvOf(apiRow.id)];
    expect(mc.modelSourceFor(apiRow.id)).toBeNull();
    expect(mc.selectableModelsFor(LOCAL_OWNER).some((m) => m.id === apiRow.id)).toBe(false);
  });
  it('目录里有 → relay；锁着的带 lockReason 出现在清单里但 allowed 里没有', () => {
    rc._setRelayCatalog({ configured: true, ok: true, at: 1, error: null, whoami: null, models: [
      { id: apiRow.id, locked: false },
      { id: 'claude-sonnet-5[1m]', locked: true, lockReason: '站点那边说要订阅' },
    ] });
    expect(mc.modelSourceFor(apiRow.id)).toBe('relay');
    const list = mc.selectableModelsFor(LOCAL_OWNER);
    expect(list.find((m) => m.id === apiRow.id)?.source).toBe('relay');
    const sonnet = list.find((m) => m.id === 'claude-sonnet-5[1m]');
    expect(sonnet?.locked).toBe(true);
    expect(sonnet?.lockReason).toBe('站点那边说要订阅');
    expect(mc.allowedModelsFor(LOCAL_OWNER).some((m) => m.id === 'claude-sonnet-5[1m]')).toBe(false);
  });
  it('本机有钥匙 → local，哪怕目录里也有（本机优先）', () => {
    const env = keyEnvOf(apiRow.id);
    expect(env).toBeTruthy();
    process.env[env] = 'my-own-key';
    expect(mc.modelSourceFor(apiRow.id)).toBe('local');
    expect(mc.selectableModelsFor(LOCAL_OWNER).find((m) => m.id === apiRow.id)?.source).toBeUndefined();
    delete process.env[env];
  });
  it('不认识的名字 → null', () => {
    expect(mc.modelSourceFor('nope')).toBeNull();
  });
});

// 09-11：目录带整行（hosted/relay/catalog.js）→ 桌面照着建行，站点加行 / 改名不用跟发桌面
describe('目录长出来的行（local profile）', () => {
  const HELPER = 'deepseek-v4-flash-helper';
  const KEY_ENV = keyEnvOf(apiRow.id);   // 收集阶段取（表还是内置那份）：被目录顶替后的行挂的是合成上游，查不到 keyEnv
  const entry = (id, extra = {}) => ({ id, locked: false, mode: 'api', label: `站点的 ${id}`, desc: 'd', brand: 'deepseek', window: 400_000, sdkAlias: mc.SHARED_SDK_ALIAS, fastModel: HELPER, protocol: 'openai-chat', prices: { input: 1, output: 2 }, ...extra });
  const v2 = () => rc._setRelayCatalog({ configured: true, ok: true, at: 1, error: null, whoami: null, renames: { 'gone-id': 'site-new-row' }, models: [
    entry('site-new-row'),
    entry(apiRow.id, { label: '站点改过的名字' }),
    entry(HELPER, { helper: true, label: undefined }),
  ] });

  it('本地表里没有的行进了选择器、能路由；改名表里的旧 id 翻得过去', () => {
    delete process.env[KEY_ENV];
    v2();
    const list = mc.selectableModelsFor(LOCAL_OWNER);
    expect(list.find((m) => m.id === 'site-new-row')).toMatchObject({ label: '站点的 site-new-row', source: 'relay' });
    expect(list.find((m) => m.id === apiRow.id)?.label).toBe('站点改过的名字');
    expect(list.some((m) => m.id === HELPER)).toBe(false);   // helper 不进选择器
    expect(mc.resolveModelRoute('site-new-row')).toMatchObject({ mode: 'api', window: 400_000, sdkAlias: mc.SHARED_SDK_ALIAS, fastModel: HELPER });
    expect(mc.resolveSdkSpoofModel('site-new-row')).toBe(mc.SHARED_SDK_ALIAS);
    expect(mc.resolveWireModel('site-new-row')?.protocol).toBe('openai-chat');   // 换模型的协议闸靠它
    expect(mc.canonicalModelId('gone-id')).toBe('site-new-row');
    expect(mc.modelSourceFor('gone-id')).toBe('relay');
    expect(mc.allowedModelsFor(LOCAL_OWNER).some((m) => m.id === 'site-new-row')).toBe(true);
  });

  it('填上钥匙重建 → 那行变回本机的内置行；拿掉再重建 → 又照目录', () => {
    const env = KEY_ENV;
    v2();
    process.env[env] = 'my-own-key';
    mc.rebuildModelIndex();
    expect(mc.modelSourceFor(apiRow.id)).toBe('local');
    expect(mc.selectableModelsFor(LOCAL_OWNER).find((m) => m.id === apiRow.id)?.label).toBe(apiRow.label);
    delete process.env[env];
    mc.rebuildModelIndex();
    expect(mc.selectableModelsFor(LOCAL_OWNER).find((m) => m.id === apiRow.id)?.label).toBe('站点改过的名字');
  });

  it('⛔ 站点把 helper 和本地改名表的目标都改了名：表照样建得出来，新行在，旧 id 两跳翻到新名字（09-11 评审）', () => {
    rc._setRelayCatalog({ configured: true, ok: true, at: 3, error: null, whoami: null,
      renames: { [HELPER]: 'helper-v2', 'deepseek-v4.1-flash': 'dsv41-v2' },
      models: [entry('site-new-row', { fastModel: 'helper-v2' }), entry('helper-v2', { helper: true, label: undefined }), entry('dsv41-v2', { fastModel: 'helper-v2' })] });
    expect(mc.selectableModelsFor(LOCAL_OWNER).some((m) => m.id === 'site-new-row')).toBe(true);
    expect(mc.canonicalModelId('deepseek-flash')).toBe('dsv41-v2');   // 本地改名表 deepseek-flash → v4.1，站点再 → dsv41-v2
    expect(mc.modelSourceFor('deepseek-flash')).toBe('relay');
  });

  it('钟点锁：照目录建的行按下发的时段现算（目录里拉取那刻的锁不照搬）；不是照目录建的行照旧信站点的锁', () => {
    const shut = { why: '高峰', tz: 'UTC', windows: ['00:00-00:01'] };   // 基本不会撞上此刻
    rc._setRelayCatalog({ configured: true, ok: true, at: 4, error: null, whoami: null, models: [
      entry('site-new-row', { locked: true, lockKind: 'closed', lockReason: '关门', unavailable: shut }),
      { id: apiRow.id, locked: true, lockKind: 'closed', lockReason: '关门' },   // 老形状（没有 mode）→ 不照目录建
    ] });
    const now = new Date('2026-09-11T12:00:00Z');
    const list = mc.selectableModelsFor(LOCAL_OWNER, { now });
    expect(list.find((m) => m.id === 'site-new-row')?.locked).toBeFalsy();
    expect(list.find((m) => m.id === apiRow.id)).toMatchObject({ locked: true, lockReason: '关门' });
    expect(mc.selectableModelsFor(LOCAL_OWNER, { now: new Date('2026-09-11T00:00:30Z') }).find((m) => m.id === 'site-new-row')?.locked).toBe(true);
  });

  it('目录没了 → 目录长出来的行跟着没了（不留一条指向站点的死行）', () => {
    v2();
    rc._setRelayCatalog({ configured: true, ok: false, at: 2, error: 'x', whoami: null, models: [] });
    expect(mc.modelSourceFor('site-new-row')).toBeNull();
    expect(mc.resolveModelRoute('site-new-row').mode).toBe('subscription');   // 不认识的 id 的老口径；turn.js 的白名单先拦
    expect(mc.selectableModelsFor(LOCAL_OWNER).some((m) => m.id === 'site-new-row')).toBe(false);
  });
});
