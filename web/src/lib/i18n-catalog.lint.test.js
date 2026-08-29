/**
 * 英文词表的对账 lint（2026-08-26）。
 *
 * key 是中文原文，所以**改源码里的中文会让翻译静默失配** —— 不报错，只是英文用户
 * 那句话悄悄变回中文。lib/i18n.js 顶上那段注释承诺"配了 lint"，这就是它。
 *
 * 方向跟服务端那条**相反**，别搞混：
 *   服务端 messages-en.js  要求「每个 msg() 的 key 都有翻译」（那批全都要翻）
 *   前端 en.js            **不**要求每个 t() 都有翻译 —— 1462 条里这轮只翻门面，
 *                         没翻的落回中文是设计。这里只钉反方向：
 *                         **词表里每一条都必须能在源码里找到对应的 t('原文')**。
 *
 * 死词条的成因有两种，都得抓：① key 打错了 ② 源码改了中文但没同步词表。
 * 两种的表现一模一样（英文用户看到中文），靠肉眼永远发现不了。
 *
 * ## 判据是「这个中文在源码里存在」，不是「它直接写在 t() 括号里」
 *
 * 第一版我钉的是后者，当场被两种正当写法撞红：
 *   ① `t(cond ? 'A' : 'B')`           三元在 t() 里面
 *   ② `t(GREETINGS[Math.random()…])`  key 来自模块级数据表，传进去的是变量
 *
 * ② 是**没法避免**的写法（问候语池、示例池就该是数据表），所以窄判据是错的。
 * 真正要防的失败只有一种：**词表里的中文在源码里根本不存在**（打错字，或者源码
 * 改了中文没同步词表），表现是英文用户静默看到中文。查"这个字符串在不在源码里"
 * 完整覆盖这一种，所以判据放宽到这里为止 —— 这也是这条 lint 能保证的全部。
 *
 * 它**不**保证「源码里每句中文都被 t() 包了」。那是另一件事，这轮故意只翻门面，
 * 没包的落回中文是设计（见 lib/i18n.js 顶上）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.jsx?$/.test(e.name) && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

/** 源码里所有**含中文的字符串字面量**（单引号 / 双引号 / 反引号都算） */
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const CJK = /[\u4e00-\u9fff]/;

const inSource = (() => {
  const seen = new Set();
  for (const f of files(SRC)) {
    if (f.includes(`${path.sep}locales${path.sep}`)) continue;   // 词表自己不算数据源
    for (const m of fs.readFileSync(f, 'utf8').matchAll(STRING_LITERAL)) {
      const v = m[1] ?? m[2] ?? m[3] ?? '';
      if (CJK.test(v)) seen.add(v);
    }
  }
  return seen;
})();

/** 另外单独抓一份「直接写在 t() 里的字面量」，只用来给下面那条计数断言当量具 */
const CALL = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
const used = (() => {
  const keys = new Set();
  for (const f of files(SRC)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(CALL)) keys.add(m[2]);
  }
  return keys;
})();

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** 词条的值可能是字符串，也可能是复数形态 { one, other } —— 取出所有要检查的文本 */
const texts = (v) => (v && typeof v === 'object' ? Object.values(v) : [v]);

describe('英文词表对账', () => {
  it('正则真的抓到了调用点（失效时这条先红，别让下面几条空转）', () => {
    expect(used.size).toBeGreaterThan(20);
  });

  it('词表里每一条中文都能在源码里找到一模一样的字符串', () => {
    const dead = Object.keys(en).filter((k) => !inSource.has(k));
    expect(dead, `这些词条在源码里找不到一模一样的字符串，翻译永远不会生效。\n`
      + `成因：key 打错了，或者源码改了中文没同步词表。\n${dead.join('\n')}`).toEqual([]);
  });

  it('中英两侧占位符集合一致（复数形态的每一支都查）', () => {
    const bad = [];
    for (const [k, v] of Object.entries(en)) {
      for (const one of texts(v)) {
        if (JSON.stringify(ph(k)) !== JSON.stringify(ph(one))) {
          bad.push(`${k}\n    zh: ${ph(k)}\n    en: ${ph(one)}  (${JSON.stringify(one)})`);
        }
      }
    }
    expect(bad, `占位符对不上，会把 {xxx} 原样印给用户：\n${bad.join('\n')}`).toEqual([]);
  });

  it('复数形态必须同时有 one 和 other（少一支时 t() 会返回 undefined）', () => {
    const bad = Object.entries(en)
      .filter(([, v]) => v && typeof v === 'object')
      .filter(([, v]) => typeof v.one !== 'string' || typeof v.other !== 'string')
      .map(([k, v]) => `${k} → ${JSON.stringify(v)}`);
    expect(bad, `复数词条缺一支：\n${bad.join('\n')}`).toEqual([]);
  });

  it('英文词条里不许残留中文（漏翻半句）', () => {
    const left = Object.entries(en)
      .filter(([, v]) => texts(v).some((one) => /[一-鿿]/.test(one)))
      .map(([k]) => k);
    expect(left, `这些词条的英文里还有中文：\n${left.join('\n')}`).toEqual([]);
  });

  it('key 不许有前后空格（复制粘贴最容易带进来，且肉眼看不见）', () => {
    const bad = Object.keys(en).filter((k) => k !== k.trim() && !k.startsWith('，') && !k.endsWith('，'));
    // 例外：'想到，' / '，验一遍' 这种是 JSX 里被拆开的句子片段，末尾/开头的标点是内容
    expect(bad, `这些 key 带了多余空格：\n${bad.map((k) => JSON.stringify(k)).join('\n')}`).toEqual([]);
  });
});
