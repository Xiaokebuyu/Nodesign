/** LibreOffice 组件的运行库就位：只在 win32、只补缺的、布局不对就什么都不做（09-15 退出码 127 案） */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLibreOfficeCrt } from './bundled-crt.js';

let dir;
const put = (rel, body = 'MZ') => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-crt-'));
  // 管理安装抽出来的真实形状：运行库只在 System64/（和 32 位的 System/），program/ 里没有
  put('program/soffice.bin');
  put('program/sal3.dll');
  put('System64/msvcp140.dll', 'crt64 msvcp');
  put('System64/vcruntime140.dll', 'crt64 vcr');
  put('System64/vcruntime140_1.dll', 'crt64 vcr1');
  put('System/msvcp140.dll', 'crt32 msvcp');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ensureLibreOfficeCrt', () => {
  it('win32：System64 的 DLL 拷进 program/，拷的是 64 位那份', () => {
    const { copied } = ensureLibreOfficeCrt(dir, { platform: 'win32' });
    expect(copied.sort()).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
    expect(fs.readFileSync(path.join(dir, 'program/msvcp140.dll'), 'utf8')).toBe('crt64 msvcp');
    // 幂等：第二次什么都不拷
    expect(ensureLibreOfficeCrt(dir, { platform: 'win32' }).copied).toEqual([]);
  });

  it('program/ 里已经有的不覆盖（新包自带，或者 soffice 正开着）', () => {
    put('program/msvcp140.dll', 'packaged');
    const { copied } = ensureLibreOfficeCrt(dir, { platform: 'win32' });
    expect(copied).not.toContain('msvcp140.dll');
    expect(fs.readFileSync(path.join(dir, 'program/msvcp140.dll'), 'utf8')).toBe('packaged');
  });

  it('不是 win32 / 没有 System64 / 没有目录：什么都不做', () => {
    expect(ensureLibreOfficeCrt(dir, { platform: 'linux' })).toEqual({ copied: [], skipped: 'not-win32' });
    expect(fs.existsSync(path.join(dir, 'program/msvcp140.dll'))).toBe(false);
    expect(ensureLibreOfficeCrt(null, { platform: 'win32' }).skipped).toBe('no-dir');
    fs.rmSync(path.join(dir, 'System64'), { recursive: true });
    expect(ensureLibreOfficeCrt(dir, { platform: 'win32' })).toEqual({ copied: [], skipped: 'layout' });
  });
});
