/**
 * 存量会话指着改名前的 id（2026-09-10）。
 *
 * 这是改名这件事最贵的那一半：session-config.json 里存的是**当时那个 id**，翻不过来的话
 * 老会话下一次发消息会被 turn 入口的白名单挡下（403「这个会话指向的模型现在不可用」），
 * 而且是每个会话都要人手换一次。规矩与表在 model-table.js 的 RENAMED_MODELS。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionModel, readSessionModelOverride } from './session-model.js';
import { RENAMED_MODELS } from './model-renames.js';

const [OLD_ID, NEW_ID] = Object.entries(RENAMED_MODELS)[0];

// ⚠️ 会话私档目录的形状是硬约束：configPath 只认 `…/.nd/<uuid>`（传错当场炸，见那儿的注释）
const SID = '00000000-1111-2222-3333-444444444444';
let root; let dir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-session-model-'));
  dir = path.join(root, '.nd', SID);
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const writeConfig = (model) => fs.writeFileSync(path.join(dir, 'session-config.json'), JSON.stringify({ model, updatedAt: 'x' }));

describe('会话里存着改名前的模型 id', () => {
  it('读出来是现在的名字（老会话不会被白名单挡下）', async () => {
    writeConfig(OLD_ID);
    expect(await readSessionModelOverride(dir)).toBe(NEW_ID);
    expect((await resolveSessionModel(dir)).model).toBe(NEW_ID);
    expect((await resolveSessionModel(dir)).override).toBe(NEW_ID);
  });

  it('盘上的文件不动 —— 翻译是读的时候做的，不去改用户的存量', async () => {
    writeConfig(OLD_ID);
    await resolveSessionModel(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'session-config.json'), 'utf8')).model).toBe(OLD_ID);
  });

  it('没改过名的 id 和没设过覆盖的会话都照旧', async () => {
    writeConfig(NEW_ID);
    expect(await readSessionModelOverride(dir)).toBe(NEW_ID);
    fs.rmSync(path.join(dir, 'session-config.json'));
    expect(await readSessionModelOverride(dir)).toBe(null);
  });
});
