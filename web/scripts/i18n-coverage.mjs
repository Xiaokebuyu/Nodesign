/**
 * i18n 覆盖率体检（2026-08-29）。
 *
 * `i18n-catalog.lint.test.js` 只钉反方向（词表里的条目在源码里必须存在），
 * 它按设计**不管**「界面上这句话有没有被包进 t()」。所以每加一批新界面，
 * 覆盖率都会往下掉，而没有任何一条测试会红 —— 这个脚本就是那把尺子。
 *
 * ⚠️ 判据必须走 AST，不能用正则：第一版拿正则抠字符串字面量，模板串那一支
 * 直接吞掉半个文件，报出来的"未翻译字符串"是几千字的代码块。判据本身要先验一遍。
 *
 *   node web/scripts/i18n-coverage.mjs            # 全站
 *   node web/scripts/i18n-coverage.mjs <git-ref>  # 只看某次改动之后动过的文件
 */
import { readFileSync, globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import en from '../src/locales/en.js';

const traverse = _traverse.default || _traverse;
const ROOT = path.resolve(import.meta.dirname, '../..');
const since = process.argv[2] || null;
const CJK = /[一-鿿]/;

function files() {
  const skip = (f) => /\.(test|lint|parity)\./.test(f) || f.includes('/locales/') || f.includes('/mock/');
  if (since) {
    const out = execFileSync('git', ['diff', '--name-only', `${since}..HEAD`, '--', 'web/src'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter(f => /\.(js|jsx)$/.test(f) && !skip(f));
  }
  return globSync('web/src/**/*.{js,jsx}', { cwd: ROOT }).filter(f => !skip(f));
}

/** 这条字符串是不是 t() 的直接参数 */
function isTranslated(p) {
  const call = p.findParent((x) => x.isCallExpression());
  if (!call) return false;
  const callee = call.node.callee;
  const name = callee.type === 'Identifier' ? callee.name
    : callee.type === 'MemberExpression' && callee.property.type === 'Identifier' ? callee.property.name : null;
  return name === 't';
}

/** console.* / 抛错文案不算界面文案 */
function isNonUi(p) {
  const call = p.findParent((x) => x.isCallExpression());
  const callee = call?.node.callee;
  if (callee?.type === 'MemberExpression' && callee.object?.name === 'console') return true;
  return !!p.findParent((x) => x.isNewExpression() && x.node.callee?.name === 'Error');
}

const rows = [];
let total = 0; let wrapped = 0; let hasEn = 0;
for (const rel of files()) {
  let ast; let src;
  // git diff 会列出后来被删掉的文件
  try { src = readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  if (!CJK.test(src)) continue;
  try {
    ast = parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  } catch { continue; }

  const seen = new Map();   // 原文 → 是否已包 t()
  traverse(ast, {
    'StringLiteral|JSXText'(p) {
      const v = p.node.value;
      if (!v || !CJK.test(v) || !v.trim()) return;
      if (isNonUi(p)) return;
      const key = v.trim();
      seen.set(key, (seen.get(key) || false) || (p.node.type === 'StringLiteral' && isTranslated(p)));
    },
    TemplateLiteral(p) {
      if (p.node.expressions.length) return;
      const v = p.node.quasis[0]?.value?.cooked || '';
      if (!v || !CJK.test(v) || !v.trim()) return;
      if (isNonUi(p)) return;
      seen.set(v.trim(), seen.get(v.trim()) || false);
    },
  });

  if (!seen.size) continue;
  const all = [...seen.keys()];
  const w = all.filter(k => seen.get(k));
  const e = all.filter(k => en[k] !== undefined);
  total += all.length; wrapped += w.length; hasEn += e.length;
  rows.push({ rel, n: all.length, w: w.length, e: e.length, raw: all.filter(k => !seen.get(k)) });
}

rows.sort((a, b) => (b.n - b.w) - (a.n - a.w));
console.log(`\n=== i18n 覆盖率（${since ? `${since}..HEAD 动过的前端文件` : '全站前端'}）===`);
console.log(`文件 ${rows.length} 个，界面上的中文字符串 ${total} 条`);
console.log(`  包进 t() 的：${wrapped}（${(wrapped / total * 100).toFixed(0)}%）`);
console.log(`  en.js 里真有译文的：${hasEn}（${(hasEn / total * 100).toFixed(0)}%）`);
console.log('\n裸中文最多的文件：');
for (const r of rows.slice(0, 15)) {
  if (r.n === r.w) continue;
  console.log(`  ${String(r.n - r.w).padStart(3)} 条裸中文  ${r.rel}   (已包 ${r.w}/${r.n})`);
  console.log(`        例：${r.raw.slice(0, 5).map(s => JSON.stringify(s.slice(0, 18))).join(' ')}`);
}
