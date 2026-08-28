/**
 * 首页那张纸（.ndd-pad）的几条硬约束（2026-08-21）。
 *
 * 这张纸是"横线本"的假象：29px 一格的横线、字必须坐在格子里、一根自己画的红光标。
 * 假象靠几个**分散在两个文件里的同一个数**撑着，任何一处飘了都不报错，只是看起来
 * 不对劲 —— 08-21 的两个真 bug 就是这么来的：
 *   1. 横线画在不跟着滚的那一层上 → 滚一下就横穿字面；
 *   2. 光标高度/视野判断对不上 → 红线飘到框外面。
 * 注释拦不住任何人（同仓规矩：契约要配 lint），所以钉在这儿。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS } from './home-styles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fs.readFileSync(path.join(HERE, 'home-quick-entry.jsx'), 'utf8');

/**
 * 取一条 CSS 规则的声明块（这几条规则体里没有嵌套花括号）。
 * ⚠️ 必须把注释剥掉再判：这几条规则的注释里就写着 `background-attachment: local` 这种话，
 * 不剥的话"删掉声明只留注释"这种改法能骗过 lint —— 写完反向攻的时候当场抓到的。
 */
function rule(selector) {
  const m = CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`home-styles.js 里找不到规则 ${selector} —— 它改名了？这条 lint 要跟着改`);
  return m[1].replace(/\/\*[\s\S]*?\*\//g, ' ');
}
const num = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`));
  return m ? Number(m[1]) : null;
};

describe('首页便签纸的横线与光标', () => {
  const ta = rule('.ndd-pad textarea ');

  it('横线画在 textarea 自己身上，且 background-attachment 是 local', () => {
    // 渐变本体 08-28 收进了配方变量 --rules（两种纸各一份，揭页动画的复制品也读它）
    expect(ta, '横线的渐变不在 textarea 上 —— 画在外层就不会跟着内容滚').toMatch(/background-image:\s*var\(--rules\)/);
    expect(ta, 'background-attachment 必须是 local，否则滚动时横线会横穿字面').toMatch(/background-attachment:\s*local/);
  });

  it('不许用 background 简写 —— 它会把 attachment 悄悄重置回 scroll', () => {
    // `background-color` / `background-image` 这些长写法不算，单独一个 `background:` 才算
    expect(ta).not.toMatch(/(?:^|[;\s])background:\s/);
  });

  it('格高 = 行高 = background-size 的高 = **每一条** --rules 的循环', () => {
    const lineHeight = num(ta, 'line-height');
    expect(lineHeight).toBe(29);
    const cell = Number(ta.match(/background-size:\s*100%\s*([\d.]+)px/)?.[1]);
    expect(cell, `background-size 的格高 ${cell} 跟行高 ${lineHeight} 对不上`).toBe(lineHeight);
    // 配方里每一条格线渐变（两种纸 × 平时/聚焦 = 四条）都得是同一个循环。
    // 08-28 把渐变收进变量之后，"改一处忘了另一处"从两处变成四处 —— 一起对。
    const grads = [...CSS.matchAll(/(--rules(?:-on)?):\s*linear-gradient\(180deg,[^;]*?[\d.]+px ([\d.]+)px\)/g)]
      .map((m) => ({ name: m[1], v: Number(m[2]) }));
    expect(grads.length, '找不到 --rules 的渐变？配方写法变了，这条 lint 要跟着改')
      .toBeGreaterThanOrEqual(4);
    const bad = grads.filter((g) => g.v !== lineHeight);
    expect(bad, `这几条格线的循环跟行高 ${lineHeight} 对不上：${JSON.stringify(bad)}`).toEqual([]);
    // 揭页复制品自己画一份格线（它没有 textarea），格高也得是同一个
    const peel = rule('.ndd-peel .lines ');
    const peelCell = Number(peel.match(/background-size:\s*100%\s*([\d.]+)px/)?.[1]);
    expect(peelCell, `被揭掉那张纸的格高 ${peelCell} 跟真输入框 ${lineHeight} 对不上 —— `
      + '切换那一瞬横线会跳一下').toBe(lineHeight);
    expect(num(peel, 'line-height'), '复制品的行高也得一样，不然带走的那份正文会错行')
      .toBe(lineHeight);
  });

  it('max-height 是格高的整数倍，且跟 JS 里那个自动撑高的上限是同一个数', () => {
    const cell = num(ta, 'line-height');
    const maxH = num(ta, 'max-height');
    const minH = num(ta, 'min-height');
    expect(maxH % cell, `max-height ${maxH} 不是 ${cell} 的整数倍，最后一格会被切一半`).toBe(0);
    expect(minH % cell, `min-height ${minH} 不是 ${cell} 的整数倍，最后一格会被切一半`).toBe(0);
    const capInJs = Number(ENTRY.match(/Math\.min\(el\.scrollHeight,\s*(\d+)\)/)?.[1]);
    expect(capInJs, `home-quick-entry.jsx 里撑高的上限 ${capInJs} 跟 CSS 的 max-height ${maxH} 不一致`).toBe(maxH);
  });

  it('**每一处** textarea 的 min/max-height 都是格高的整数倍（含 @media 里的覆盖）', () => {
    const cell = num(ta, 'line-height');
    // 窄屏那一段又写了一个 min-height —— 上面那条只看基础规则，看不见它
    const found = [...CSS.matchAll(/\.ndd-pad textarea[^{]*\{([^}]*)\}/g)]
      .flatMap((m) => [...m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/(min|max)-height:\s*([\d.]+)px/g)])
      .map((m) => ({ prop: `${m[1]}-height`, v: Number(m[2]) }));
    expect(found.length, '一处都没找到？选择器改名了，这条 lint 要跟着改').toBeGreaterThanOrEqual(3);
    const bad = found.filter((f) => f.v % cell !== 0);
    expect(bad, `这些高度不是 ${cell} 的整数倍，最后一格会被切一半：${JSON.stringify(bad)}`).toEqual([]);
  });

  it('红光标的高度两边对得上（判"滚出视野了没有"要用它）', () => {
    const cssH = num(rule('.ndd-pad .caret '), 'height');
    const jsH = Number(ENTRY.match(/const CARET_H = (\d+);/)?.[1]);
    expect(jsH, `CARET_H=${jsH} 跟 CSS 里的 height:${cssH}px 对不上`).toBe(cssH);
  });

  it('.lines 那层不许再画横线 —— 它不跟着内容滚', () => {
    expect(rule('.ndd-pad .lines ')).not.toMatch(/background/);
  });
});

/**
 * 页签跟纸的接缝（2026-08-28）。
 *
 * 「选中的那片签就是这张纸」这个假象靠两件事：**同一个背景色**、
 * **三个 margin 是同一个数的三种写法**（条 -6 / 没选 +6 / 选中 0）。
 * 任何一处飘了都不报错，只是签浮起来一道缝、或者陷进纸里半格 ——
 * 跟上面横线那族是同一类债，所以钉在同一个文件里。
 */
describe('首页页签跟纸的接缝', () => {
  const strip = rule('.ndd-pad .tabs ');
  const off = rule('.ndd-pad .tabs > * ');
  const on = rule('.ndd-pad .tabs > *.on ');

  /**
   * 底色 08-28 收成一个变量：纸和它的签都写 var(--sheet)，配方类换的是变量的值。
   * 于是"两边颜色对不上"这条债从**每加一种纸就多一条**变成**结构上不可能**——
   * 这条 lint 现在守的是这个结构本身别被人改回去写死颜色。
   */
  it('纸和它的签读的是同一个变量（写死颜色就等于把接缝的债又请回来）', () => {
    const bgOf = (body) => body.match(/background-color:\s*([^;]+)/)?.[1].trim() || null;
    expect(bgOf(rule('.ndd-pad ')), '.ndd-pad 的底色得读配方变量 --sheet').toBe('var(--sheet)');
    expect(bgOf(on), '选中那片签的底色也得读 --sheet —— 跟纸是同一张纸').toBe('var(--sheet)');
  });

  /** 配方缺一个变量 = var() 落空 = 那张纸整块没底色/没格线，而且一声不吭 */
  it('每种纸的配方四个变量齐全（--sheet / --sheet-under / --rules / --rules-on）', () => {
    const recipes = [...CSS.matchAll(/\.nd-sheet-([a-z][\w-]*)\s*\{([^}]*)\}/g)]
      .filter((m) => m[2].includes('--sheet:'));
    expect(recipes.length, '一份配方都没找到？.nd-sheet-* 改名了，这条 lint 要跟着改')
      .toBeGreaterThanOrEqual(2);
    for (const [, name, body] of recipes) {
      for (const v of ['--sheet:', '--sheet-under:', '--rules:', '--rules-on:']) {
        expect(body.includes(v), `.nd-sheet-${name} 缺 ${v} —— var() 落空是静默的，`
          + '那张纸会整块没底色或者没格线').toBe(true);
      }
    }
  });

  /** JSX 挑配方类靠一张表，表里写错一个字就是"那种纸压根没有配方" */
  it('SHEET_CLS 里的每个类名在 CSS 里都真有配方', () => {
    const tbl = ENTRY.match(/const SHEET_CLS = \{([^}]*)\}/)?.[1];
    expect(tbl, 'home-quick-entry.jsx 里找不到 SHEET_CLS').toBeTruthy();
    const cls = [...tbl.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(cls.length, 'SHEET_CLS 是空的？').toBeGreaterThanOrEqual(2);
    for (const c of cls) {
      expect(CSS.includes(`.${c} {`), `SHEET_CLS 指到 .${c}，但 CSS 里没有这份配方`).toBe(true);
    }
  });

  it('条往下沉多少，没选的那片就往上抬回多少（下缘正落在纸的边线上）', () => {
    const sink = num(strip, 'margin-bottom');
    const back = num(off, 'margin-bottom');
    expect(sink, '.ndd-pad .tabs 得往下沉一段（负 margin-bottom），签才伸得进纸里').toBeLessThan(0);
    expect(back, `条沉了 ${sink}、没选的那片抬回 ${back} —— 抬不回去它就压在纸上了`).toBe(-sink);
  });

  it('选中那片一路沉到底（margin-bottom: 0），跟纸连成一体', () => {
    // 0 可以写成 `0` 也可以写成 `0px`，两种都认（num 只认带单位的）
    expect(on, '选中的签必须 margin-bottom:0，才跟纸没有分界线').toMatch(/margin-bottom:\s*0(px)?\s*[;}]/);
  });

  it('那枚胶囊已经拆干净（.ndd-mode 一处都不许剩）', () => {
    expect(CSS, '.ndd-mode 的样式还在 —— 它已经被页签替掉了').not.toMatch(/\.ndd-mode/);
    expect(ENTRY, 'home-quick-entry.jsx 里还挂着 ndd-mode').not.toMatch(/ndd-mode/);
  });
});
