import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCjkFonts, loProfileFontSubstitutionXcu, windowsFontDirs } from './cjk-fonts.js';

describe('中文字体齐不齐', () => {
  it('非 Windows 不查；Windows 按文件名查两个目录；缺的才进替换表且 Always=false', () => {
    expect(checkCjkFonts({ platform: 'linux' })).toMatchObject({ checked: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-fonts-'));
    for (const f of ['simsun.ttc', 'msyh.ttc', 'simhei.ttf']) fs.writeFileSync(path.join(dir, f), '');
    const r = checkCjkFonts({ platform: 'win32', dirs: [dir] });
    expect(r.present.sort()).toEqual(['宋体', '微软雅黑', '黑体'].sort());
    expect(r.missing.sort()).toEqual(['仿宋', '楷体'].sort());
    const xcu = loProfileFontSubstitutionXcu(r);
    expect(xcu).toContain('<value>楷体</value>');
    expect(xcu).toContain('LXGW WenKai');
    expect(xcu).toContain('Zhuque Fangsong');
    expect(xcu).not.toContain('<value>宋体</value>');
    expect((xcu.match(/<value>false<\/value>/g) || []).length).toBeGreaterThanOrEqual(2);   // Always=false
    expect(loProfileFontSubstitutionXcu({ checked: true, missing: [], present: [] })).toBeNull();
    expect(loProfileFontSubstitutionXcu({ checked: false, missing: [], present: [] })).toBeNull();
    expect(windowsFontDirs({ WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\U\\AppData\\Local' })).toHaveLength(2);
  });
});
