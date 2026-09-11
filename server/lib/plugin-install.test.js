import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPluginToRoot } from './plugin-install.js';

/**
 * 覆盖安装（force）不以"删得掉旧的"为前提（09-11）。
 * 原来是先 rm 旧目录再 rename 新目录：Windows 上 rename 一 EPERM，旧版已经没了。
 * 这里不用真 Windows，直接让 fs.rename 在指定那一步抛 EPERM。
 */

const MD = (n, v) => `---\nname: ${n}\ndescription: 测试用\nversion: ${v}\n---\n# ${n} ${v}\n`;
const tmps = [];
function root() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-plugin-install-'));
  tmps.push(d);
  return d;
}
const versionOf = (r, n) => JSON.parse(fs.readFileSync(path.join(r, n, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const staged = (r) => { try { return fs.readdirSync(path.join(r, '.staging')); } catch { return []; } };
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

describe('force 覆盖安装', () => {
  it('正常路径：新版就位，让位的旧目录删干净，.staging 里不留东西', async () => {
    const r = root();
    expect((await installPluginToRoot(Buffer.from(MD('pa', '0.1.0')), r)).status).toBe(201);
    const res = await installPluginToRoot(Buffer.from(MD('pa', '0.2.0')), r, { force: true });
    expect(res.status).toBe(200);
    expect(versionOf(r, 'pa')).toBe('0.2.0');
    expect(staged(r)).toEqual([]);
  });

  it('⛔ 新版挪不进来（EPERM）：旧版挪回原位，还能用', async () => {
    const r = root();
    await installPluginToRoot(Buffer.from(MD('pb', '0.1.0')), r);
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(r, 'pb') && String(from).includes(`${path.sep}.staging${path.sep}pb-`)) throw eperm();
      return real(from, to);
    });
    await expect(installPluginToRoot(Buffer.from(MD('pb', '0.2.0')), r, { force: true })).rejects.toThrow(/EPERM/);
    expect(versionOf(r, 'pb')).toBe('0.1.0');
    expect(staged(r)).toEqual([]);   // 这次的解压目录也收拾掉了
  });

  it('⛔ 旧版挪不开（有文件被攥着）：旧版原样留着，这次算装失败', async () => {
    const r = root();
    await installPluginToRoot(Buffer.from(MD('pc', '0.1.0')), r);
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (from === path.join(r, 'pc')) throw eperm();
      return real(from, to);
    });
    await expect(installPluginToRoot(Buffer.from(MD('pc', '0.2.0')), r, { force: true })).rejects.toThrow(/EPERM/);
    expect(versionOf(r, 'pc')).toBe('0.1.0');
    expect(staged(r)).toEqual([]);
  });

  it('上次没删掉的让位目录，下次安装开头顺手清掉', async () => {
    const r = root();
    fs.mkdirSync(path.join(r, '.staging', 'pd.old-abc123', 'x'), { recursive: true });
    await installPluginToRoot(Buffer.from(MD('pd', '0.1.0')), r);
    expect(staged(r)).toEqual([]);
  });
});
