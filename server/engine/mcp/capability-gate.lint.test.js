/**
 * 能力闸对照表的守卫（09-09）：凡是（直接或经 helper）开 chromium 的工具都得在 TOOL_CAPABILITIES 里挂 chromium 位。
 *
 * 真案（问题库 iss_mtr33277_qs9n）：look_at_board 走 launchPerceptionBrowser，缺二进制时却没像
 * screenshot_canvas 那样标 UNAVAILABLE —— 表是手抄的，新加一个开浏览器的工具就漏一个。
 * 判据按源码的 import 图：从 `import('playwright')` / `from 'playwright'` 的模块出发，沿相对 import
 * 反向传播到 tools/ 下的文件，那些文件里 `tool('xxx', …)` 注册的每个名字都必须在表里、cap 是 chromium。
 * ⚠️ 例外要写在下面的 EXEMPT 里并给理由，别改判据。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_CAPABILITIES } from './capability-gate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, '..');
const toolsDir = path.join(here, 'tools');
const PLAYWRIGHT = /import\(\s*'playwright'\s*\)|from\s+'playwright'/;
const IMPORTS = /(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g;
const TOOL_NAME = /\btool\(\s*'([a-z_]+)'/g;
/** 工具名 → 理由。列在这儿的不用挂 chromium 位 */
const EXEMPT = {
  // screenshot_canvas 的 docx 分支走 LibreOffice，但它本身也开 chromium，所以不豁免——这里目前没有例外
};

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p, out); continue; }
    if (f.endsWith('.js') && !f.includes('.test.')) out.push(p);
  }
  return out;
}

describe('capability-gate 对照表 vs 源码 import 图', () => {
  it('每个（传递地）开 chromium 的工具都挂了 chromium 位', () => {
    const files = walk(engineDir);
    const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
    // 反向依赖：被谁 import
    const importedBy = new Map();
    for (const [f, s] of src) {
      for (const m of s.matchAll(IMPORTS)) {
        let target = path.resolve(path.dirname(f), m[1]);
        if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`;
        if (!importedBy.has(target)) importedBy.set(target, new Set());
        importedBy.get(target).add(f);
      }
    }
    // 从直接开 playwright 的模块出发传播
    const tainted = new Set([...src].filter(([, s]) => PLAYWRIGHT.test(s)).map(([f]) => f));
    const queue = [...tainted];
    while (queue.length) {
      const f = queue.pop();
      for (const up of importedBy.get(f) || []) if (!tainted.has(up)) { tainted.add(up); queue.push(up); }
    }
    const seen = []; const missing = [];
    for (const f of tainted) {
      if (!f.startsWith(toolsDir + path.sep) || f.includes(`${path.sep}helpers${path.sep}`)) continue;
      for (const m of src.get(f).matchAll(TOOL_NAME)) {
        const name = m[1];
        seen.push(name);
        if (EXEMPT[name]) continue;
        if (TOOL_CAPABILITIES[name]?.cap !== 'chromium') missing.push(`${path.relative(engineDir, f)}: ${name}`);
      }
    }
    // 判据自检：传播真起作用（screenshot_canvas 是经 helper 间接开的，look_at_board 是直接开的）
    expect(seen).toContain('screenshot_canvas');
    expect(seen).toContain('look_at_board');
    expect(seen).toContain('browser_navigate');
    expect(missing).toEqual([]);
  });
});
