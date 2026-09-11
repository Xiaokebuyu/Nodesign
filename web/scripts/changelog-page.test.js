/**
 * 更新日志单一来源（2026-09-11）：官网 changelog.html 的日志区必须由 CHANGELOG.md 生成。
 * 只改一边就红 —— 修法是改 CHANGELOG.md 后跑 `node web/scripts/changelog-page.mjs`。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MD, PAGE, parse, render, build } from './changelog-page.mjs';

describe('changelog', () => {
  it('⛔ changelog.html 与 CHANGELOG.md 同步（改 CHANGELOG.md 后要跑生成脚本）', () => {
    expect(build() === fs.readFileSync(PAGE, 'utf8'), 'changelog.html 与 CHANGELOG.md 不一致：跑 node web/scripts/changelog-page.mjs').toBe(true);
  });

  it('每一节都有日期和要点，最新的在最上面', () => {
    const e = parse(fs.readFileSync(MD, 'utf8'));
    expect(e.length).toBeGreaterThan(10);
    for (const x of e) { expect(x.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(x.items.length).toBeGreaterThan(0); }
    const dates = e.map((x) => x.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('要点里的尖括号会转义，反引号渲染成 code', () => {
    const html = render(parse('## 2026-01-01 · v1\n\n### 标题\n\n- 用 `npx a` 运行 <b>x</b>\n'));
    expect(html).toContain('<code>npx a</code>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
