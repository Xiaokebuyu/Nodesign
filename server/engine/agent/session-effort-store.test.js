/** 会话思考等级的存取（2026-09-13）：跟 model 同一份 session-config.json、同一把锁，互不吃字段。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionEffort, writeSessionEffort, writeSessionModelOverride, readSessionModelOverride } from './session-model.js';

const SID = '00000000-1111-2222-3333-555555555555';
let root; let dir;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-session-effort-')); dir = path.join(root, '.nd', SID); fs.mkdirSync(dir, { recursive: true }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('session-config.json 的 effort', () => {
  it('没选过是 null；写了读得回；null 清掉字段', async () => {
    expect(await readSessionEffort(dir)).toBeNull();
    expect(await writeSessionEffort(dir, 'high')).toEqual({ effort: 'high', changed: true });
    expect(await readSessionEffort(dir)).toBe('high');
    expect(await writeSessionEffort(dir, 'high')).toEqual({ effort: 'high', changed: false });
    await writeSessionEffort(dir, null);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'session-config.json'), 'utf8'))).not.toHaveProperty('effort');
  });
  it('⭐ 并发写模型和档位不互相吃字段（同一把锁）', async () => {
    await Promise.all([writeSessionModelOverride(dir, 'claude-opus-5[1m]'), writeSessionEffort(dir, 'xhigh')]);
    expect(await readSessionModelOverride(dir)).toBe('claude-opus-5[1m]');
    expect(await readSessionEffort(dir)).toBe('xhigh');
  });
  it('文件里写坏的档位读成 null', async () => {
    fs.writeFileSync(path.join(dir, 'session-config.json'), JSON.stringify({ effort: 'ultra' }));
    expect(await readSessionEffort(dir)).toBeNull();
  });
});
