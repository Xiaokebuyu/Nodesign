/**
 * 合 main 前的迁移抽查（2026-08-29）：**新代码读得动生产上那 159 个真板子吗**
 *
 * 判据不是"能 JSON.parse"，是 sanitizeBoard 之后**有没有悄悄少东西**。
 * 分支这 105 个 commit 动过 seat 语义、tag 域、kinds、bindings 端点，
 * 任何一条收紧了都会表现成"用户打开项目发现东西不见了"，而且不报错。
 *
 * 只读：不写任何生产文件。
 *   node server/_probe-prod-board-compat.mjs [projects-data 目录]
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeBoard } from './projects/board-sanitize.js';

const ROOT = process.argv[2] || '/home/wangang-dev/projects/Nodesign/server/projects-data';
const dirs = (await readdir(ROOT, { withFileTypes: true })).filter(d => d.isDirectory());

let ok = 0; let missing = 0; const bad = []; const lossy = [];
for (const d of dirs) {
  const p = path.join(ROOT, d.name, 'shared', 'board.json');
  let raw;
  try {
    raw = JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') { missing += 1; continue; }
    bad.push({ pid: d.name, why: `解析失败 ${e.message}` });
    continue;
  }
  let out;
  try {
    out = sanitizeBoard(raw);
  } catch (e) {
    bad.push({ pid: d.name, why: `sanitize 抛了 ${e.message}` });
    continue;
  }
  const before = { o: Object.keys(raw.objects || {}).length, b: Object.keys(raw.bindings || {}).length };
  const after = { o: Object.keys(out.objects || {}).length, b: Object.keys(out.bindings || {}).length };
  if (after.o < before.o || after.b < before.b) {
    const dropped = Object.keys(raw.objects || {}).filter(k => !(k in (out.objects || {})));
    lossy.push({
      pid: d.name,
      objects: `${before.o}→${after.o}`,
      bindings: `${before.b}→${after.b}`,
      sample: dropped.slice(0, 3),
    });
  } else ok += 1;
}

console.log(`\n生产项目 ${dirs.length} 个：有板子 ${dirs.length - missing}，没板子 ${missing}`);
console.log(`  ✅ 读进来不丢东西：${ok}`);
console.log(`  ⛔ 读不动：${bad.length}`);
console.log(`  ⚠️  读得动但少了东西：${lossy.length}`);
for (const b of bad.slice(0, 10)) console.log(`     ⛔ ${b.pid}  ${b.why}`);
for (const l of lossy.slice(0, 15)) {
  console.log(`     ⚠️  ${l.pid}  objects ${l.objects}  bindings ${l.bindings}  丢的例子: ${l.sample.join(', ')}`);
}
process.exit(bad.length || lossy.length ? 1 : 0);
