// 09-09 桌面版 0.1.34 案：导出 HTML 时寻址层把站点**文件夹**当文件返回，下游 readFile 直接 EISDIR 500。
// 站点卡的 id 就是文件夹名，导出菜单 / 工具把它原样喂进来是常态，寻址层要落到入口文件。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveArtifactTarget } from './artifact-target.js';

let root;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-target-dir-'));
  await fs.mkdir(path.join(root, 'Nodesign官网/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'Nodesign官网/index.html'), '<html></html>');
  await fs.writeFile(path.join(root, 'Nodesign官网/pricing.html'), '<html></html>');
  await fs.mkdir(path.join(root, '空文件夹'), { recursive: true });
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('resolveArtifactTarget 收到文件夹', () => {
  it('站点文件夹 → 它的 index.html，形态 site', async () => {
    const t = await resolveArtifactTarget(root, 'Nodesign官网', 'sid-1');
    expect(t.ok).toBe(true);
    expect(t.relPath).toBe('Nodesign官网/index.html');
    expect(t.absPath).toBe(path.resolve(root, 'Nodesign官网/index.html'));
    expect(t.kind).toBe('site');
    expect((await fs.stat(t.absPath)).isFile()).toBe(true);
  });
  it('带尾斜杠 / 反斜杠也一样', async () => {
    expect((await resolveArtifactTarget(root, 'Nodesign官网/', 'sid-2')).relPath).toBe('Nodesign官网/index.html');
    expect((await resolveArtifactTarget(root, 'Nodesign官网\\', 'sid-3')).relPath).toBe('Nodesign官网/index.html');
  });
  it('没有入口文件的文件夹 → not found，不是一个指向目录的 ok', async () => {
    const t = await resolveArtifactTarget(root, '空文件夹', 'sid-4');
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/not found/);
  });
  it('显式文件路径照旧', async () => {
    const t = await resolveArtifactTarget(root, 'Nodesign官网/pricing.html', 'sid-5');
    expect(t.ok).toBe(true);
    expect(t.relPath).toBe('Nodesign官网/pricing.html');
  });
});
