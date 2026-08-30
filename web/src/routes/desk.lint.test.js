/**
 * 台面（desk.jsx）的几条硬约束（2026-08-30 夜里那支粉笔）。
 *
 * 背景：夜晚模式是**把光收走** —— 底层那一刀把台面压到亮度 6-8%。
 * 摊在台面上的纸不受影响（纸是不透明的，上面的墨照旧），但站点上有一整类字
 * 是**直接写在板面上的**：左栏那本账、「我的项目」、橱窗和 Skill 页的大标题。
 * 它们是深色的笔，板一黑就跟着灭（量过：账目 1.64 / 标题 2.28 / 橱窗 2.54）。
 * 解法是夜里整族翻成粉笔。
 *
 * 这里钉三件在实现过程中真踩过的事。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAPER_VARS } from '../lib/paper.js';
import { DESK_CSS } from './desk.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const LIGHT = read('home-light.jsx');
const HOME = read('home-styles.js');
/** 判据只看真生效的声明 —— 这几条规则的注释里正写着它们在告诫什么 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** 取一条规则的声明块 */
const rule = (css, sel) => {
  const i = code(css).indexOf(`${sel} {`);
  return i < 0 ? null : code(css).slice(i, code(css).indexOf('}', i));
};

describe('夜里板上的字要翻成粉笔', () => {
  it('⭐ 有夜的钩子：html 上挂标记 + CSS 认这个标记', () => {
    // 光的状态本来只活在 localStorage 和模块里，CSS 够不着
    expect(LIGHT, 'home-light 没往 html 上挂标记').toMatch(/dataset\.ndLight/);
    expect(code(DESK_CSS), 'desk.jsx 里没有夜的那条规则')
      .toMatch(/:root\[data-nd-light="night"\]\s+\.ndd\s*\{/);
  });

  it('⭐ 夜里那条规则要把整族都换掉，漏一档就有一行字灭着', () => {
    const night = rule(DESK_CSS, ':root[data-nd-light="night"] .ndd');
    expect(night, '夜的规则不见了').toBeTruthy();
    for (const v of ['--desk-ink', '--desk-ink-2', '--desk-pencil',
      '--sketch', '--sketch-deep', '--sketch-soft', '--sketch-num', '--sketch-rule']) {
      expect(night, `夜里漏了 ${v}`).toMatch(new RegExp(`${v}\\s*:`));
    }
    // 白天那一份得在 PAPER_VARS 里（登录墙也吃这一份，一支笔只能有一处真身）
    for (const v of ['--sketch', '--sketch-deep', '--sketch-soft', '--sketch-num', '--sketch-rule']) {
      expect(code(PAPER_VARS), `PAPER_VARS 里没有 ${v}`).toMatch(new RegExp(`${v}\\s*:`));
    }
  });

  it('⛔ .ndd 自己不许拿 --desk-* 当继承色（会把纸上的字一起带走）', () => {
    // 真踩过：卡片标题 .ndd-card .t 没写自己的 color，夜里跟着继承成白字
    // 压在亮纸上，量出 1.03:1。台面是台面，摊在上面的纸是纸。
    const ndd = rule(DESK_CSS, '.ndd');
    expect(ndd, '.ndd 规则不见了').toBeTruthy();
    expect(ndd, '.ndd 的 color 不能是 --desk-*').not.toMatch(/color:\s*var\(--desk-/);
  });

  it('⭐ 站在台面上的那几处必须显式写 --desk-ink（别指望继承）', () => {
    for (const sel of ['.ndd-greet', '.ndd-head h2']) {
      expect(rule(HOME, sel), `${sel} 没走 --desk-ink，夜里会灭`).toMatch(/color:\s*var\(--desk-ink\)/);
    }
  });
});
