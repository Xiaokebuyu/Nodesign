// 版本号只有一个来源（09-11）：package.json。lock 的根版本要跟着它，health / 诊断 / 状态接口都读 platform.appVersion。
// 此前发版只改 package.json（0.1.39 那个提交），lock 停在 0.1.38；health 写死 '0.1.0'。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { platform } from './platform.js';

const read = (f) => JSON.parse(fs.readFileSync(path.join(platform.repoRoot, f), 'utf8'));

describe('版本号', () => {
  it('package-lock.json 的根版本跟 package.json 一致（改版本号后跑一次 npm install --package-lock-only）', () => {
    const pkg = read('package.json');
    const lock = read('package-lock.json');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(lock.packages[''].engines).toEqual(pkg.engines);
  });
  it('platform.appVersion 就是 package.json 的 version', () => {
    expect(platform.appVersion).toBe(read('package.json').version);
  });
});
