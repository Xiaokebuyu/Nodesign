/**
 * runtime/local-config.js 的校验钉子（纯函数 validateLocalConfig）+ 合并进模型表后的会话优先路由
 * （子进程：model-context 在 import 时读配置，得用 NODESIGN_MODELS_CONFIG 指一份临时文件）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLocalConfig, MAX_RETRY_BUDGET_MS, RESERVED_MODEL_IDS, SHADOWABLE_MODEL_IDS } from './local-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const GOOD = {
  upstreams: {
    relay: { baseUrl: 'https://api.example.com/', protocol: 'openai-chat', key: 'sk-test' },
    anth: { baseUrl: 'https://relay2.example.com', keyEnv: 'MY_RELAY_KEY' },
  },
  models: [
    { id: 'kimi-k2', label: 'Kimi K2', window: 262144, upstream: 'relay', wireModel: 'kimi-k2-0905', reasoningEffort: 'high', prices: { input: 0.6, output: 2.5 } },
    { id: 'glm-5', label: 'GLM 5', desc: '便宜', window: 1_000_000, upstream: 'anth', wireModel: 'glm-5', fastModel: 'kimi-k2' },
  ],
};

describe('validateLocalConfig', () => {
  it('好配置：归一化成 UPSTREAMS 条目形状，authStyle 按协议补默认，baseUrl 去尾斜杠', () => {
    const v = validateLocalConfig(GOOD);
    expect(v.errors).toEqual([]);
    expect(v.upstreams.relay).toMatchObject({ label: 'relay', baseUrl: 'https://api.example.com', protocol: 'openai-chat', authStyle: 'bearer', key: 'sk-test', keyEnv: null, countTokens: false, external: true });
    expect(v.upstreams.anth).toMatchObject({ authStyle: 'x-api-key', key: null, keyEnv: 'MY_RELAY_KEY', protocol: 'anthropic' });
    expect(v.models.map((m) => m.id)).toEqual(['kimi-k2', 'glm-5']);
    expect(v.models[0]).toMatchObject({ thinking: 'strip', brand: 'custom', desc: '', liftImages: false });
  });

  it('一条坏了不连坐：坏行被丢、记进 errors、好行照常', () => {
    const v = validateLocalConfig({
      upstreams: { ...GOOD.upstreams, zenGo: { baseUrl: 'https://x.example.com', key: 'k' }, nokey: { baseUrl: 'https://y.example.com' } },
      models: [...GOOD.models,
        { id: 'claude-sonnet-5', label: '撞内置 Claude 订阅名', window: 100000, upstream: 'relay', wireModel: 'x' },
        { id: 'orphan', label: '指向不存在的上游', window: 100000, upstream: 'ghost', wireModel: 'x' },
        { id: 'badfast', label: 'fast 指错', window: 100000, upstream: 'relay', wireModel: 'x', fastModel: 'nope' },
        { id: 'toolong', label: '预算超线', window: 100000, upstream: 'relay', wireModel: 'x', emptyRetries: 3, retryBudgetMs: MAX_RETRY_BUDGET_MS + 1 },
        { id: 'extra', label: '多了字段', window: 100000, upstream: 'relay', wireModel: 'x', sdkAlias: 'claude-opus-5[1m]' },
      ],
    });
    expect(Object.keys(v.upstreams).sort()).toEqual(['anth', 'relay']);
    expect(v.models.map((m) => m.id)).toEqual(['kimi-k2', 'glm-5']);
    const text = v.errors.map((e) => `${e.where} ${e.message}`).join('\n');
    expect(text).toMatch(/upstreams\.zenGo .*内置上游名/);
    expect(text).toMatch(/upstreams\.nokey .*key 或 keyEnv/);
    expect(text).toMatch(/claude-sonnet-5.*内置 Claude 订阅模型名/);
    expect(text).toMatch(/orphan.*upstream 'ghost' 不存在/);
    expect(text).toMatch(/badfast.*fastModel 'nope'/);
    expect(text).toMatch(/toolong.*retryBudgetMs/);
    expect(text).toMatch(/extra.*sdkAlias/);   // strict：不认识的字段报出来，别静默吞（sdkAlias 是自动分配的，不许手填）
  });

  it('同名顶替（09-09）：内置 API 行的 id 可以做插槽 id（不报错、原样进表）；订阅 Claude 名仍保留', () => {
    const v = validateLocalConfig({
      upstreams: GOOD.upstreams,
      models: [
        { id: 'glm-5.3-flash-merge', label: '顶替内置 API 行', window: 100000, upstream: 'relay', wireModel: 'glm-5.3-flash' },
        { id: 'claude-opus-5', label: '订阅名', window: 100000, upstream: 'anth', wireModel: 'claude-opus-5' },
      ],
    });
    expect(v.models.map((m) => m.id)).toEqual(['glm-5.3-flash-merge']);
    expect(v.errors.map((e) => e.message).join('\n')).toMatch(/claude-opus-5.*内置 Claude 订阅模型名/);
    expect(SHADOWABLE_MODEL_IDS).toContain('glm-5.3-flash-merge');
    expect(RESERVED_MODEL_IDS).toContain('claude-opus-5');
    expect(RESERVED_MODEL_IDS.some((id) => SHADOWABLE_MODEL_IDS.includes(id))).toBe(false);
  });

  it('根不是对象 / 坏 JSON 形状 → 一条错、空配置', () => {
    expect(validateLocalConfig([]).errors[0].message).toMatch(/必须是一个对象/);
    expect(validateLocalConfig({ upstreams: [], models: {} }).errors.length).toBeGreaterThan(0);
  });
});

describe('外部插槽进表 + 会话优先路由（子进程）', () => {
  it('两条外部行共用 SHARED_SDK_ALIAS：各自的会话把 alias 解回自己；没会话的 alias 请求 502(null)；内置行路由不变', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-cfg-'));
    const cfg = path.join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify(GOOD));
    const code = `
      import { resolveWireModel, resolveModelRoute, SHARED_SDK_ALIAS, MODEL_CONFIG_ERRORS, selectableModelsFor, UPSTREAMS } from '../engine/agent/model-context.js';
      import { registerIngressSession, resolveSessionWire } from '../lib/ingress/session-routes.js';
      registerIngressSession('s1', 'kimi-k2'); registerIngressSession('s2', 'glm-5'); registerIngressSession('s3', 'deepseek-v4-flash-vision');
      const bare = SHARED_SDK_ALIAS.replace(/\\[1m\\]$/, '');
      const pick = (r) => r && r.wire ? { app: r.wire.appModel, role: r.role, reason: r.reason, up: r.wire.upstreamId, proto: r.wire.protocol, wire: r.wire.wireModel } : null;
      console.log(JSON.stringify({
        errors: MODEL_CONFIG_ERRORS,
        route: resolveModelRoute('kimi-k2'),
        s1: pick(resolveSessionWire(bare, 's1')), s1full: pick(resolveSessionWire(SHARED_SDK_ALIAS, 's1')),
        s2: pick(resolveSessionWire(bare, 's2')), s2fast: pick(resolveSessionWire('kimi-k2', 's2')), s2unknown: pick(resolveSessionWire('claude-sonnet-5', 's2')),
        nosess: resolveSessionWire(bare, null).wire, byId: pick({ wire: resolveWireModel('kimi-k2'), role: 'main', reason: 'table' }),
        s3: pick(resolveSessionWire('claude-opus-4-7', 's3')), s3helper: pick(resolveSessionWire('deepseek-v4-flash-helper', 's3')), s3collide: pick(resolveSessionWire('claude-opus-4-6', 's3')),
        picker: selectableModelsFor({ id: 'u', role: 'admin' }).filter((m) => ['kimi-k2', 'glm-5'].includes(m.id)).map((m) => m.id),
        relayKey: UPSTREAMS.relay.key,
      }));`;
    const base = { ...process.env }; delete base.NODESIGN_PROFILE; delete base.VITEST;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_MODELS_CONFIG: cfg, DB_PATH: path.join(dir, 'x.db') }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(o.errors).toEqual([]);
    expect(o.route).toMatchObject({ mode: 'api', appModel: 'kimi-k2', sdkAlias: 'claude-sonnet-4-6[1m]', fastModel: 'kimi-k2', window: 262144, upstreamId: 'relay' });
    expect(o.s1).toMatchObject({ app: 'kimi-k2', role: 'main', reason: 'table', up: 'relay', proto: 'openai-chat', wire: 'kimi-k2-0905' });
    expect(o.s1full).toMatchObject({ app: 'kimi-k2', role: 'main' });
    expect(o.s2).toMatchObject({ app: 'glm-5', role: 'main', proto: 'anthropic' });
    expect(o.s2fast).toMatchObject({ app: 'kimi-k2', role: 'helper', reason: 'table' });
    expect(o.s2unknown).toMatchObject({ app: 'kimi-k2', role: 'helper', reason: 'fallback' });
    expect(o.nosess).toBeNull();
    expect(o.byId.app).toBe('kimi-k2');
    // 内置行：自己的 alias 解回自己、helper 行、撞名雷改道 —— 08-20 封的口子一个不松
    expect(o.s3).toMatchObject({ app: 'deepseek-v4-flash-vision', role: 'main', reason: 'table' });
    expect(o.s3helper).toMatchObject({ app: 'deepseek-v4-flash-helper', role: 'helper', reason: 'table' });
    expect(o.s3collide).toMatchObject({ app: 'deepseek-v4-flash-helper', role: 'helper', reason: 'collision' });   // opus-4-6 是 gemini 行的独占 alias：别家的钥匙，绝不放过去
    // hosted profile（子进程没设 NODESIGN_PROFILE）下外部行也进 picker（钥匙过滤只在 local），key 在条目上
    expect(o.picker.sort()).toEqual(['glm-5', 'kimi-k2']);
    expect(o.relayKey).toBe('sk-test');
  });

  it('同名顶替进表（09-09）：外部行顶掉同名内置 API 行，路由走用户上游；引用被顶行做 fast/standby 的内置行断言照过；local picker 靠用户的 key 列出它', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-cfg-'));
    const cfg = path.join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({
      upstreams: { 'my-deepseek': { baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat', key: 'sk-mine' } },
      models: [
        { id: 'deepseek-v4-flash-vision', label: '我的', window: 128000, upstream: 'my-deepseek', wireModel: 'deepseek-v4-flash-vision' },
        { id: 'deepseek-v4-flash-helper', label: '我的 helper', window: 128000, upstream: 'my-deepseek', wireModel: 'deepseek-v4-flash' },
      ],
    }));
    const code = `
      import { resolveModelRoute, MODEL_CONFIG_ERRORS, shadowedBuiltinModelIds, externalModelIds, selectableModelsFor, standbyModelOf, modelSourceFor } from '../engine/agent/model-context.js';
      const r = resolveModelRoute('deepseek-v4-flash-vision');
      console.log(JSON.stringify({ errors: MODEL_CONFIG_ERRORS, shadowed: shadowedBuiltinModelIds(), external: externalModelIds(),
        up: r.upstreamId, mode: r.mode, sdkAlias: r.sdkAlias,
        picker: selectableModelsFor({ id: '_anon', role: 'admin' }).filter((m) => m.id.startsWith('deepseek-v4')).map((m) => [m.id, modelSourceFor(m.id)]),
        standby: standbyModelOf('deepseek-v4.1-flash-expires-on-0910') }));`;
    const base = { ...process.env }; delete base.VITEST; delete base.DEEPSEEK_API_KEY;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, NODESIGN_MODELS_CONFIG: cfg, DB_PATH: path.join(dir, 'x.db') }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(o.errors).toEqual([]);
    expect(o.shadowed.sort()).toEqual(['deepseek-v4-flash-helper', 'deepseek-v4-flash-vision']);
    expect(o.external.sort()).toEqual(['deepseek-v4-flash-helper', 'deepseek-v4-flash-vision']);
    expect(o).toMatchObject({ up: 'my-deepseek', mode: 'api' });
    expect(o.standby).toBe('deepseek-v4-flash-vision');   // 内置行的 standby 指向被顶的名字 → 现在解到用户那行，断言不炸
    expect(o.picker).toContainEqual(['deepseek-v4-flash-vision', 'local']);   // 本机钥匙优先：不走 relay
    expect(o.picker.map(([id]) => id)).not.toContain('deepseek-v4.1-flash-expires-on-0910');   // 没顶的内置行本机没钥匙、也没 relay → 照旧藏
  });

  it('local profile：外部行进 picker 靠条目上的 key（不是 env）；keyEnv 没设的行藏掉（08-22 smoke 抓到的洞）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-cfg-'));
    const cfg = path.join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify(GOOD));
    const code = `
      import { selectableModelsFor } from '../engine/agent/model-context.js';
      console.log(JSON.stringify(selectableModelsFor({ id: '_anon', role: 'admin' }).map((m) => m.id)));`;
    const base = { ...process.env }; delete base.VITEST; delete base.MY_RELAY_KEY;
    const run = (extra) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, NODESIGN_MODELS_CONFIG: cfg, ...extra }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const without = run({});
    expect(without).toContain('kimi-k2');        // key 内联
    expect(without).not.toContain('glm-5');      // keyEnv MY_RELAY_KEY 没设
    expect(without).not.toContain('glm-5.3-flash-merge');   // 内置行钥匙没配
    expect(run({ MY_RELAY_KEY: 'x' })).toContain('glm-5');
  });

  it('local profile：内置 Claude 行要本机有凭据才进 picker（没 key 没登录 = 空着指路，08-22 用户要求）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-cfg-'));
    const cfg = path.join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ upstreams: {}, models: [] }));
    const home = path.join(dir, 'home'); const cfgDir = path.join(dir, 'claude-cfg');
    mkdirSync(home, { recursive: true }); mkdirSync(cfgDir, { recursive: true });
    const code = `
      import { selectableModelsFor } from '../engine/agent/model-context.js';
      import { platform } from './platform.js';
      console.log(JSON.stringify({ via: platform.claudeAuthPresent(), ids: selectableModelsFor({ id: '_anon', role: 'admin' }).map((m) => m.id) }));`;
    const base = { ...process.env }; delete base.VITEST; delete base.ANTHROPIC_API_KEY; delete base.NODESIGN_CONFIG_DIR;
    const run = (extra) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: here, env: { ...base, NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dir, NODESIGN_MODELS_CONFIG: cfg, HOME: home, USERPROFILE: home, NODESIGN_CONFIG_DIR: cfgDir, ...extra }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const bare = run({});
    expect(bare.via).toBe(null);
    expect(bare.ids).toEqual([]);                                  // 什么都没配：一行都不给
    const withKey = run({ ANTHROPIC_API_KEY: 'sk-x' });
    expect(withKey.via).toBe('api_key');
    expect(withKey.ids).toContain('claude-sonnet-5[1m]');
    // ⏸ 站主 09-06：本地版暂不认 claude login 的登录态（platform.LOCAL_CLAUDE_LOGIN_ENABLED=false）。
    // 凭据文件在也当没配 —— 用户机器上的订阅骑进来计量外审都够不着。开关翻回去时把这两条断言换回 'login'
    writeFileSync(path.join(cfgDir, '.credentials.json'), '{}');  // claude login 落盘的样子
    const loggedIn = run({});
    expect(loggedIn.via).toBe(null);
    expect(loggedIn.ids).toEqual([]);
  });
});
