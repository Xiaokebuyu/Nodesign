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
    expect(ta, '横线的渐变不在 textarea 上 —— 画在外层就不会跟着内容滚').toMatch(/background-image:\s*linear-gradient/);
    expect(ta, 'background-attachment 必须是 local，否则滚动时横线会横穿字面').toMatch(/background-attachment:\s*local/);
  });

  it('不许用 background 简写 —— 它会把 attachment 悄悄重置回 scroll', () => {
    // `background-color` / `background-image` 这些长写法不算，单独一个 `background:` 才算
    expect(ta).not.toMatch(/(?:^|[;\s])background:\s/);
  });

  it('格高 = 行高 = background-size 的高，三个数必须是同一个', () => {
    const lineHeight = num(ta, 'line-height');
    const cell = Number(ta.match(/background-size:\s*100%\s*([\d.]+)px/)?.[1]);
    const grad = Number(ta.match(/linear-gradient\(180deg,[^;]*?[\d.]+px ([\d.]+)px\)/)?.[1]);
    expect(lineHeight).toBe(29);
    expect(cell, `background-size 的格高 ${cell} 跟行高 ${lineHeight} 对不上`).toBe(lineHeight);
    expect(grad, `渐变一个循环 ${grad} 跟行高 ${lineHeight} 对不上`).toBe(lineHeight);
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
  const off = rule('.ndd-pad .tabs button ');
  const on = rule('.ndd-pad .tabs button.on ');

  it('选中那片的背景色跟纸是同一个 token（差一点就露出接缝）', () => {
    const pad = rule('.ndd-pad ').match(/background-color:\s*([^;]+)/)?.[1].trim();
    const tab = on.match(/background-color:\s*([^;]+)/)?.[1].trim();
    expect(pad, '.ndd-pad 得用 background-color 长写法（简写会顺手重置别的）').toBe('var(--paper)');
    expect(tab, `选中的签是 ${tab}、纸是 ${pad} —— 两者必须一模一样，否则接缝处露一道边`).toBe(pad);
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
