/**
 * 把 JSX 里的裸中文包进 t()（2026-08-29）。
 *
 * ## 为什么是改写源码不是跑 codegen
 *
 * 走 @babel/generator 会把整个文件重排一遍 —— 这些文件是逐像素调过版面的 JSX，
 * 重排出来的 diff 没法读、JSX 里的空白节点还会变（空白在 JSX 里是有语义的）。
 * 所以只用 AST **定位**，改写靠按 offset 从后往前切原始文本，格式一个字符不动。
 *
 * ## 只包能安全包的
 *
 *   JSX 属性     title="重命名"        → title={t('重命名')}
 *   JSX 文本     <span>已上线</span>   → <span>{t('已上线')}</span>
 *   JSX 里的表达式  {a ? '甲' : '乙'}     → {a ? t('甲') : t('乙')}
 *
 * ⛔ **模块级 const 里的中文一律不碰**。t() 不是 hook，在定义处包等于把语言
 * 钉死在 import 那一刻，之后切语言不会重挂（i18n.js 文件头那条规矩）。那种表
 * 要在**取用处**包，只能一个个手改。这个脚本会把它们列出来但不改。
 *
 *   node web/scripts/i18n-wrap.mjs <file...>        # 试跑，只报不写
 *   node web/scripts/i18n-wrap.mjs --write <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FILES = args.filter((a) => !a.startsWith('--'));
const CJK = /[一-鿿]/;
const looksLikeCode = (v) => /[{};]/.test(v) && /[:;]\s|\n/.test(v);
/** 这仓用单引号；JSON.stringify 出的是双引号，含单引号或反斜杠时才退回它 */
// ⚠️ 只有"纯净"的字符串才配单引号：带换行/制表/反斜杠/单引号的一律交给
// JSON.stringify —— 第一版只挡了单引号和反斜杠，带 \n 的文案直接生成出
// unterminated string，vite build 不报，是 no-undef 那条 lint 逮住的。
const q = (v) => (/['\\\n\r\t\u2028\u2029]/.test(v) ? JSON.stringify(v) : `'${v}'`);

/**
 * ⛔ **句子碎片不许包**。JSX 里一句话被 <a>/<span> 断成几段时，每段各包一个 t()
 * 等于把词序赌在中英一致上 —— 「到 <a>设置</a> 填 API Key」在英文里那三块的顺序
 * 是反的（登录墙那次「三段 t() 拼标题=词序赌博」记的就是这个）。
 * 判据一：这段文本的父元素里还有别的**元素**兄弟 → 它是碎片。
 * 判据二：以续接标点开头/结尾（，、：；（）→ 它是碎片。
 */
const CONT = /^[，、：；（(]|[，、：；（(]$/;
function textHasElementSiblings(p) {
  const kids = p.parent?.children || [];
  return kids.some((c) => c.type === 'JSXElement' || c.type === 'JSXFragment');
}

/**
 * ⛔ **`t` 在这个位置被遮蔽了就不许包**（2026-09-02 补）。
 *
 * 08-26 那轮，这个脚本把 `'剥掉（非 Claude 用这个）'` 包进了
 * `THINKING_MODES.map((t) => …)` 的回调里 —— 那里的 `t` 是回调参数，不是 i18n 的 t，
 * 于是包出来的 `t('剥掉…')` 是拿字符串当函数调。`vite build` 不报，
 * 设置页 models 为空时那一行压根不渲染，一路发到 npm 0.0.8：
 * 用户点「加一行」直接白屏，BYOK 那条线上配不出模型来。
 *
 * 脚本改的代码没人逐行看，所以判据得在这儿。包不了的照样报出来，人去把局部变量改名。
 * （另一头的守卫在 web/src/lib/i18n-shadow.lint.test.js —— 那条管全仓，这条管这把刀。）
 */
function tIsShadowed(p, tSpecNode) {
  const b = p.scope.getBinding('t');
  return !!b && b.path.node !== tSpecNode;
}

/** console.* 是开发日志不是界面文案 */
function inConsole(p) {
  const call = p.findParent((x) => x.isCallExpression());
  const callee = call?.node.callee;
  return callee?.type === 'MemberExpression' && callee.object?.name === 'console';
}

let totalWrapped = 0;
for (const rel of FILES) {
  const abs = path.resolve(rel);
  const src = readFileSync(abs, 'utf8');
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'], ranges: true });

  const edits = [];      // { start, end, text }
  const skipped = [];
  const shadowed = [];   // t 在那个位置被局部绑定遮住了，包了就是运行时崩
  let hasT = false;
  let tSpec = null;      // i18n 那条 ImportSpecifier，用来认"这个 t 是不是 import 来的那个"

  traverse(ast, {
    ImportDeclaration(p) {
      if (!p.node.source.value.endsWith('lib/i18n.js')) return;
      const spec = p.node.specifiers.find((s) => s.imported?.name === 't');
      if (spec) { hasT = true; tSpec = spec; }
    },
    JSXAttribute(p) {
      const v = p.node.value;
      if (v?.type !== 'StringLiteral' || !CJK.test(v.value) || looksLikeCode(v.value)) return;
      if (tIsShadowed(p, tSpec)) { shadowed.push(v.value); return; }
      edits.push({ start: v.start, end: v.end, text: `{t(${q(v.value)})}` });
    },
    JSXText(p) {
      const raw = p.node.value;
      if (!CJK.test(raw) || looksLikeCode(raw)) return;
      if (tIsShadowed(p, tSpec)) { shadowed.push(raw.trim()); return; }
      if (textHasElementSiblings(p)) { skipped.push(raw.trim()); return; }
      if (CONT.test(raw.trim())) { skipped.push(raw.trim()); return; }
      const lead = raw.match(/^\s*/)[0];
      const tail = raw.match(/\s*$/)[0];
      const body = raw.slice(lead.length, raw.length - tail.length);
      if (!body) return;
      edits.push({ start: p.node.start, end: p.node.end, text: `${lead}{t(${q(body)})}${tail}` });
    },
    StringLiteral(p) {
      const v = p.node.value;
      if (!CJK.test(v) || looksLikeCode(v)) return;
      if (p.parent.type === 'JSXAttribute' || p.parent.type === 'ImportDeclaration') return;
      if (inConsole(p)) return;
      if (tIsShadowed(p, tSpec)) { shadowed.push(v); return; }
      if (CONT.test(v.trim())) { skipped.push(v); return; }
      // 已经在 t() 里了
      if (p.parent.type === 'CallExpression' && p.parent.callee?.name === 't') return;
      // ⛔ 拿来比大小的字符串包了就等于改逻辑（`mode === '演出'` 包完永远不相等）
      const par = p.parent;
      if (par.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(par.operator)) return;
      if (par.type === 'SwitchCase' && par.test === p.node) return;
      if (par.type === 'MemberExpression' && par.computed) return;
      if (par.type === 'ObjectProperty' && par.key === p.node) return;
      // includes/startsWith/indexOf 这类也是在比对不是在显示
      if (par.type === 'CallExpression' && par.callee?.type === 'MemberExpression'
        && ['includes', 'startsWith', 'endsWith', 'indexOf', 'has', 'get', 'set', 'delete'].includes(par.callee.property?.name)) return;

      // 只动**运行时求值**的那些：JSX 表达式容器里，或者函数体里（toast / dialog 文案）。
      // 模块级的表不碰 —— t() 不是 hook，在定义处包等于把语言钉死在 import 那一刻。
      const inJsx = p.findParent((x) => x.isJSXExpressionContainer());
      const inFn = p.findParent((x) => x.isFunctionDeclaration() || x.isArrowFunctionExpression() || x.isFunctionExpression() || x.isClassMethod() || x.isObjectMethod());
      if (!inJsx && !inFn) { skipped.push(v); return; }
      edits.push({ start: p.node.start, end: p.node.end, text: `t(${q(v)})` });
    },
  });

  if (!edits.length && !skipped.length && !shadowed.length) { console.log(`  —  ${rel}`); continue; }

  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  if (edits.length && !hasT) {
    const depth = path.relative(path.dirname(abs), path.resolve('web/src/lib')).replace(/\\/g, '/');
    const spec = `${depth.startsWith('.') ? depth : `./${depth}`}/i18n.js`;
    const m = out.match(/^import[^\n]*\n(?![\s\S]*^import)/m);
    const lastImport = [...out.matchAll(/^import[^\n]*\n/gm)].pop();
    const at = lastImport ? lastImport.index + lastImport[0].length : 0;
    out = `${out.slice(0, at)}import { t } from '${spec}';\n${out.slice(at)}`;
    void m;
  }

  console.log(`  ${String(edits.length).padStart(3)} 包了  ${rel}${skipped.length ? `   ⛔ ${skipped.length} 条跳过（模块级表 / 句子碎片），要手改：${skipped.slice(0, 3).map(s => JSON.stringify(s)).join(' ')}` : ''}${shadowed.length ? `   ⚠️ ${shadowed.length} 条那里的 t 被局部变量遮住了（包了就是 "t is not a function"），先给那个变量改名：${shadowed.slice(0, 3).map(s => JSON.stringify(s)).join(' ')}` : ''}`);
  totalWrapped += edits.length;
  if (WRITE && edits.length) writeFileSync(abs, out);
}
console.log(`\n${WRITE ? '已写入' : '试跑'}：共 ${totalWrapped} 条`);
