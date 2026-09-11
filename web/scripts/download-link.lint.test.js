/**
 * 桌面版下载链接只许写固定名（2026-09-11）。
 *
 * 起因：官网三页写死了 NoDesign-Setup-0.1.34.exe。desktop.yml 往 R2 只留最近 3 个安装包，
 * 0.1.37 发出后那个文件被清掉，官网所有「下载 Windows 版」按钮 404，没人发现。
 * 固定名 NoDesign-Setup.exe 由 .github/workflows/desktop-link.yml 在每次发版后更新。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WELCOME = path.join(ROOT, 'web/public/welcome');
const FILES = [
  ...fs.readdirSync(WELCOME).filter((f) => f.endsWith('.html')).map((f) => path.join(WELCOME, f)),
  ...['README.md', 'README.en.md', 'README.zh-CN.md'].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];
const VERSIONED = /NoDesign-Setup-\d+\.\d+\.\d+\.exe/g;

describe('桌面版下载链接', () => {
  it('官网与 README 找得到', () => {
    expect(FILES.length).toBeGreaterThan(3);
  });

  it('⛔ 不许链到带版本号的安装包（R2 只留最近 3 版，旧链接会 404）', () => {
    const hits = FILES.flatMap((f) => (fs.readFileSync(f, 'utf8').match(VERSIONED) || []).map((m) => `${path.relative(ROOT, f)}: ${m}`));
    expect(hits, '改成 https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe').toEqual([]);
  });
});
