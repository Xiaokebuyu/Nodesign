/**
 * 官网数字自动刷新的契约（2026-09-11）：页面上每个 data-stat 都得有人算；算不出来时保留旧值。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, applyStats, fmtWan, floorHundredYu, bjDate } from './site-stats.mjs';

const WELCOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/welcome');
const pages = fs.readdirSync(WELCOME).filter((f) => f.endsWith('.html')).map((f) => [f, fs.readFileSync(path.join(WELCOME, f), 'utf8')]);

describe('site-stats', () => {
  it('⛔ 页面上每个 data-stat 键脚本都会算（否则那个数永远停在手填值）', () => {
    const used = new Set();
    for (const [, html] of pages) for (const m of html.matchAll(/data-stat="([a-zA-Z0-9]+)"/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((k) => !KEYS.includes(k))).toEqual([]);
  });

  it('data-stat 只能挂在不含子元素的 b/span/strong/em 上（替换逻辑只认这种形状）', () => {
    for (const [f, html] of pages) {
      for (const m of html.matchAll(/<(\w+)\b[^>]*\bdata-stat="[^"]+"[^>]*>([^<]*)</g)) {
        expect(['b', 'span', 'strong', 'em'], `${f}: <${m[1]} data-stat>`).toContain(m[1]);
      }
      const n = (html.match(/data-stat="/g) || []).length;
      const { changed } = applyStats(html, Object.fromEntries(KEYS.map((k) => [k, `__${k}__`])));
      expect(changed.length, `${f}: 有 data-stat 没被替换到`).toBe(n);
    }
  });

  it('算不出来的键保留旧值，不写空', () => {
    const html = '<b data-stat="users">139</b> <span data-stat="tools">60</span>';
    const { html: out, changed } = applyStats(html, { users: null, tools: '61' });
    expect(out).toBe('<b data-stat="users">139</b> <span data-stat="tools">61</span>');
    expect(changed).toEqual(['tools']);
  });

  it('格式', () => {
    expect(fmtWan(42107)).toBe('4.2 万');
    expect(fmtWan(9800)).toBe('9,800');
    expect(floorHundredYu(2553)).toBe('2,500 余');
    expect(bjDate(new Date('2026-09-11T16:30:00Z'))).toBe('2026 年 9 月 12 日');
  });
});
