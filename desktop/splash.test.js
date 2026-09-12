/**
 * 起动画跟站内印刷风同一套颜色（2026-09-12）。这一屏读不到站内 token（服务端还没起），
 * 颜色是抄的字面量 —— 这条钉住它跟 paper.js 的 BASE 没漂。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const splash = fs.readFileSync(path.join(here, 'splash.html'), 'utf8');
const paperJs = fs.readFileSync(path.join(here, '..', 'web', 'src', 'lib', 'paper.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(here, 'main.js'), 'utf8');
const token = (name) => paperJs.match(new RegExp(`\\b${name}:\\s*'(#[0-9A-Fa-f]{6})'`))?.[1];

describe('桌面起动画 · 印刷风', () => {
  it('纸色 / 墨色 / 分区线跟 paper.js 的 BASE 一致；窗口底色也是纸色', () => {
    for (const [css, tok] of [['--paper', 'paper'], ['--ink', 'ink'], ['--ink2', 'ink2'], ['--kraft', 'kraft']]) {
      const v = token(tok);
      expect(v, tok).toBeTruthy();
      expect(splash).toContain(`${css}: ${v}`);
    }
    expect(mainJs).toContain(`backgroundColor: '${token('paper')}'`);
  });
  it('没有改版前的橙色进度条和暖白底', () => {
    expect(splash).not.toMatch(/#c8783c|#faf8f4|#e8e2d8/i);
    expect(mainJs).not.toMatch(/#faf8f4/i);
  });
});
