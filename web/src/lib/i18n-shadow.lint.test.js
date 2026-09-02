/**
 * i18n 的 `t` 不许被遮蔽（2026-09-02）。
 *
 * ## 起因：npm 0.0.8 的本地版根本加不了模型
 *
 * 设置页模型行里有这么一句（SlotEditor.jsx，08-26 i18n 那轮包上去的）：
 *
 *     enums.THINKING_MODES.map((t) => ({ value: t, label: t === 'strip' ? t('剥掉…') : t }))
 *
 * 回调参数叫 `t`，把模块顶上 `import { t } from '../../lib/i18n.js'` 遮住了。
 * 于是 `t('剥掉…')` 是**拿字符串 'strip' 当函数调** —— 一点上「② 模型 · 加一行」
 * 就 `TypeError: t is not a function`，整条路由被 React Router 的错误边界接管，
 * 白屏。换句话说 BYOK 那条线上**没有一个用户能通过表单配出模型来**。
 *
 * 为什么没被拦住：
 *   - `vite build` 不管遮蔽，压出来照样是合法 JS（minify 后叫 `le is not a function`）；
 *   - 这一句在 08-24 的 0.0.7 里还是好的 —— 是 i18n-wrap 那一轮**自动**把裸字符串
 *     包成 `t(...)` 时包进了一个已经有 `t` 的作用域里。机器改的代码没人逐行看；
 *   - 设置页当时没有渲染测试，`models` 为空时这一行压根不渲染，本机随手一开也是好的。
 *
 * ⭐ 这三条凑一起 = 一个**只在用户手上出现**的崩溃。所以钉在这儿。
 *
 * ## 两道闸
 *
 *   ① 硬闸：文件里每一处 `t(...)` 都必须解析到那条 import —— 解析到别的绑定就是已经坏了。
 *   ② 前置闸：干脆不许在这种文件里再声明一个叫 `t` 的东西，陷阱在成型前就红。
 *      真要拿 `t` 当时间参数/元素变量，换个名字（`mode` / `item` / `time`），
 *      别在这条规则上开豁免 —— ① 的失败是静默白屏，不值得为省一个改名冒险。
 *
 * 这道 lint 自己攻过：下面「攻自己」那节把 0.0.8 那一行原样喂回去，两条各自变红；
 * 另外真去 git 上把修复退掉跑了一遍，也是红的。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SKIP_DIRS = new Set(['node_modules', 'projects-data', 'dist', 'dist-build', 'coverage']);

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sourceFiles(p, out); continue; }
    if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 扫一个文件，返回 { calls, shadows }。
 * 文件没从 i18n 里 import `t` 就返回空 —— 这条规则只管"有 i18n 的文件"，
 * 别处叫 t 的参数（缓动函数的时间、role-target 里的元素）是正当的。
 */
export function scanI18nShadow(code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'importMeta', 'topLevelAwait'] });

  let local = null;      // i18n 的 t 在这个文件里叫什么（一般就是 t）
  let specNode = null;   // 那条 ImportSpecifier，用来认"这个绑定就是 import 来的那个"
  traverse(ast, {
    ImportDeclaration(p) {
      if (!/i18n(\.js)?$/.test(p.node.source.value)) return;
      for (const s of p.node.specifiers) {
        if (s.type === 'ImportSpecifier' && (s.imported.name || s.imported.value) === 't') { local = s.local.name; specNode = s; }
      }
    },
  });
  if (!local) return { calls: [], shadows: [] };

  const calls = [], shadows = new Map();
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee;
      if (c.type !== 'Identifier' || c.name !== local) return;
      const b = p.scope.getBinding(local);
      // 解析不到（被谁 delete 了？）或解析到 import 以外的绑定 = 这一处已经坏了
      if (!b || b.path.node !== specNode) calls.push(p.node.loc?.start.line ?? 0);
    },
    Scopable(p) {
      const b = (p.scope.bindings || {})[local];
      if (!b || b.path.node === specNode) return;
      const line = b.identifier?.loc?.start.line ?? b.path.node.loc?.start.line ?? 0;
      shadows.set(line, b.kind);
    },
  });
  return { calls, shadows: [...shadows.entries()].map(([line, kind]) => ({ line, kind })) };
}

describe('i18n 的 t 不许被遮蔽', () => {
  const files = [
    ...sourceFiles(path.join(REPO, 'web/src')),
    ...sourceFiles(path.join(REPO, 'server')),
  ];
  const scanned = files.map((f) => {
    const rel = path.relative(REPO, f).split(path.sep).join('/');
    try { return { rel, ...scanI18nShadow(fs.readFileSync(f, 'utf8')) }; }
    catch (err) { return { rel, parseErr: err.message, calls: [], shadows: [] }; }
  });

  it('⛔ 每一处 t(…) 都解析到 i18n 那条 import', () => {
    const bad = scanned.flatMap(({ rel, calls }) => calls.map((line) => `${rel}:${line} 这里的 t 不是 i18n 的 t —— 它被局部绑定遮住了，运行到就是 "t is not a function"`));
    expect(bad, `压不出错、build 不报，只有用户会撞见：\n${bad.join('\n')}`).toEqual([]);
  }, 60_000);

  it('⭐ import 了 i18n 的文件里不许再声明叫 t 的绑定', () => {
    const bad = scanned.flatMap(({ rel, shadows }) => shadows.map(({ line, kind }) => `${rel}:${line} 又声明了一个 t（${kind}）—— 换个名字（mode / item / time）`));
    expect(bad, `陷阱在这一步就该红，别等到有人往里面写 t('…')：\n${bad.join('\n')}`).toEqual([]);
  }, 60_000);

  it('解析失败要报出来，不许静默跳过', () => {
    const bad = scanned.filter((s) => s.parseErr).map((s) => `${s.rel}: ${s.parseErr}`);
    expect(bad, '解析不了的文件等于没扫 —— 那是漏报').toEqual([]);
  });
});

describe('攻自己：0.0.8 那一行必须能被抓住', () => {
  // 逐字抄自 0.0.8 的 SlotEditor.jsx:229（就是它让用户白屏的）
  const BROKEN = `
    import { t } from '../../lib/i18n.js';
    export default function Row({ enums, m }) {
      return <Select value={m.thinking || 'strip'}
        options={enums.THINKING_MODES.map((t) => ({ value: t, label: t === 'strip' ? t('剥掉（非 Claude 用这个）') : t }))} />;
    }`;
  const FIXED = BROKEN.replace(/\(\(t\) =>/, '((mode) =>').replace(/value: t, label: t === 'strip' \? t\(/, "value: mode, label: mode === 'strip' ? t(").replace(/\) : t \}\)\)/, ') : mode }))');

  it('坏的那版两条都红', () => {
    const r = scanI18nShadow(BROKEN);
    expect(r.calls.length, '没抓到「t 解析到局部绑定」= 硬闸是摆设').toBeGreaterThan(0);
    expect(r.shadows.length, '没抓到遮蔽 = 前置闸是摆设').toBeGreaterThan(0);
  });

  it('改完名两条都绿', () => {
    const r = scanI18nShadow(FIXED);
    expect(r.calls).toEqual([]);
    expect(r.shadows).toEqual([]);
  });

  it('没 import i18n 的文件不管（缓动函数的 t 是正当的）', () => {
    const r = scanI18nShadow('export const ease = (t) => t * t;');
    expect(r.calls).toEqual([]);
    expect(r.shadows).toEqual([]);
  });
});
