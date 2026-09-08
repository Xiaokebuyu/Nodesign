import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDebugOptions, claudeDebugDir } from './debug-file.js';

const SID = 'ed914e35-4b50-4afe-b60b-5c0aeab304c9';
describe('claudeDebugOptions', () => {
  it('本地版：建目录、回 debugFile 路径、清 7 天前的旧文件；托管版 / 坏 sid 回空对象', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-debug-'));
    const dir = claudeDebugDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.txt'); fs.writeFileSync(old, 'x');
    const past = Date.now() - 8 * 24 * 3600 * 1000; fs.utimesSync(old, past / 1000, past / 1000);
    const fresh = path.join(dir, 'fresh.txt'); fs.writeFileSync(fresh, 'x');
    const out = claudeDebugOptions(SID, { isLocal: true, dataRoot: root });
    expect(out.debugFile).toBe(path.join(dir, `${SID}.txt`));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(claudeDebugOptions(SID, { isLocal: false, dataRoot: root })).toEqual({});
    expect(claudeDebugOptions('../x', { isLocal: true, dataRoot: root })).toEqual({});
    expect(claudeDebugOptions(SID, { isLocal: true, dataRoot: null })).toEqual({});
  });
});
