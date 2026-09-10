/**
 * 导出落盘的算术（2026-09-10）。09-09 那案的两个教训都钉在这儿：
 * 存哪儿归主进程定（页面给的名字只能当名字），重名要让位（那正是"文件被拿走"的证据源）。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { safeFileName, exportDirFrom, uniqueTarget } from './export-target.js';

describe('safeFileName', () => {
  it('剥掉目录：页面说了不算存哪儿', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Windows\\System32\\x.dll')).toBe('x.dll');
    expect(safeFileName('a/b/c.png')).toBe('c.png');
  });
  it('Windows 收不了的字符换成下划线，中文原样', () => {
    expect(safeFileName('a:b|c?.zip')).toBe('a_b_c_.zip');
    expect(safeFileName('Nodesign官网.zip')).toBe('Nodesign官网.zip');
  });
  it('空名字有兜底', () => {
    expect(safeFileName('')).toBe('导出');
    expect(safeFileName(null)).toBe('导出');
  });
});

describe('exportDirFrom', () => {
  const downloads = path.join(path.sep, 'home', 'me', 'Downloads');
  it('设了、是绝对路径、目录还在 → 用它', () => {
    const custom = path.join(path.sep, 'data', 'exports');
    expect(exportDirFrom({ exportDir: custom }, downloads, () => true)).toBe(custom);
  });
  it('没设 / 相对路径 / 目录没了 → 回系统「下载」', () => {
    expect(exportDirFrom({}, downloads, () => true)).toBe(downloads);
    expect(exportDirFrom({ exportDir: 'exports' }, downloads, () => true)).toBe(downloads);
    expect(exportDirFrom({ exportDir: path.join(path.sep, 'gone') }, downloads, () => false)).toBe(downloads);
  });
  it('探目录本身抛了（权限没了）也回默认，不往上炸', () => {
    expect(exportDirFrom({ exportDir: path.join(path.sep, 'x') }, downloads, () => { throw new Error('EACCES'); })).toBe(downloads);
  });
});

describe('uniqueTarget', () => {
  const dir = path.join(path.sep, 'dl');
  it('没重名就用原名', () => {
    expect(uniqueTarget(dir, 'a.zip', () => false)).toBe(path.join(dir, 'a.zip'));
  });
  it('重名往后让：(2) (3)，扩展名留在最后', () => {
    const taken = new Set([path.join(dir, 'a.zip'), path.join(dir, 'a (2).zip')]);
    expect(uniqueTarget(dir, 'a.zip', (p) => taken.has(p))).toBe(path.join(dir, 'a (3).zip'));
  });
  it('没有扩展名也让得动', () => {
    const taken = new Set([path.join(dir, 'note')]);
    expect(uniqueTarget(dir, 'note', (p) => taken.has(p))).toBe(path.join(dir, 'note (2)'));
  });
});
