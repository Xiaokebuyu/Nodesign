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
