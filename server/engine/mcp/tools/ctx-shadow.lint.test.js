// 工具工厂拿到的 agent ctx 不许在函数体里被同名变量遮住（09-17）
// screenshot-url.js 把浏览器 context 也叫 ctx，run.screenshot_taken 从上线起一次都没发到前端，没有任何报错。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

describe('工具工厂里的 ctx 不被遮蔽', () => {
  it('参数里解构了 ctx 的文件，函数体内不再声明 ctx', () => {
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!/export (async )?function make\w*\(\{[^)]*\bctx\b[^)]*\}/.test(src)) continue;
      const m = src.match(/^\s*(const|let|var)\s+ctx\s*=/m);
      if (m) bad.push(`${f}: ${m[0].trim()}`);
    }
    expect(bad).toEqual([]);
  });
  it('判据本身有效：screenshot-url.js 在被检查的文件里', () => {
    const src = fs.readFileSync(path.join(dir, 'screenshot-url.js'), 'utf8');
    expect(/export (async )?function make\w*\(\{[^)]*\bctx\b[^)]*\}/.test(src)).toBe(true);
  });
});
