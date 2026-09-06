import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.NODESIGN_PROFILE = 'local';
process.env.NODESIGN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-home-'));
process.env.NODESIGN_CONFIG_DIR = '/nonexistent';
const prefs = await import('./local-prefs.js');
const rc = await import('./relay-client.js');
const mc = await import('../engine/agent/model-context.js');
const { LOCAL_OWNER } = await import('../auth/users-store.js');

const apiRow = mc.SELECTABLE_MODELS.find((m) => mc.resolveModelRoute(m.id).mode === 'api' && !m.only && mc.resolveWireModel(m.id)?.upstream?.keyEnv);
const another = mc.SELECTABLE_MODELS.find((m) => m.id !== apiRow.id && mc.resolveModelRoute(m.id).mode === 'api' && !m.only && mc.resolveWireModel(m.id)?.upstream?.keyEnv);

describe('local-prefs', () => {
  it('没文件 → 默认；写了再读回；不认识的键丢掉', () => {
    expect(prefs.loadPrefs()).toEqual({ hiddenModels: [], defaultModel: null, setupDone: false });
    expect(prefs.savePrefs({ hiddenModels: ['a', 'a', 3, ''], defaultModel: 'x', junk: 1, setupDone: 'yes' })).toEqual({ hiddenModels: ['a'], defaultModel: 'x', setupDone: false });
    prefs._resetPrefsCache();
    expect(prefs.loadPrefs()).toEqual({ hiddenModels: ['a'], defaultModel: 'x', setupDone: false });
    expect(prefs.savePrefs({ setupDone: true }).setupDone).toBe(true);
    expect(JSON.parse(fs.readFileSync(prefs.prefsPath, 'utf8')).junk).toBeUndefined();
  });
  it('藏起来的行带 hidden 标仍在清单里；默认模型按偏好，藏了就退回可见的第一个', () => {
    rc._setRelayCatalog({ configured: true, ok: true, at: 1, error: null, whoami: null, models: [{ id: apiRow.id, locked: false }, { id: another.id, locked: false }] });
    prefs.savePrefs({ hiddenModels: [], defaultModel: another.id });
    expect(mc.defaultModelFor(LOCAL_OWNER)).toBe(another.id);
    prefs.savePrefs({ hiddenModels: [another.id] });
    const list = mc.selectableModelsFor(LOCAL_OWNER);
    expect(list.find((m) => m.id === another.id)?.hidden).toBe(true);
    expect(mc.allowedModelsFor(LOCAL_OWNER).some((m) => m.id === another.id)).toBe(true);   // 藏 ≠ 禁
    expect(mc.defaultModelFor(LOCAL_OWNER)).toBe(apiRow.id);
  });
});
