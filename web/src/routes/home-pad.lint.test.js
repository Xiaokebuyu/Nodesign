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
const SHEETS = fs.readFileSync(path.join(HERE, 'home-sheets.js'), 'utf8');
const HOME = fs.readFileSync(path.join(HERE, 'Home.jsx'), 'utf8');

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
  const strip = rule('.nd-tabs ');
  const off = rule('.nd-tabs > * ');
  const on = rule('.nd-tabs > *.on ');

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
  /**
   * 纸上印好的东西不许吃指针（2026-08-28 真 bug）。
   *
   * 稿纸的版心框是个 inset 几乎铺满整张纸的 ::before，默认吃指针 —— 于是演出模式下
   * 工具栏的「加附件」和「开工」全点不着（只有自己 position:relative 的模型选择器和
   * 正文幸免，它们画在框之上）。修法是一条**跟配方无关**的规则；这条 lint 守的是
   * 它别退化成"一种纸一句"，那种写法漏了不报错，只是那张纸上的按钮悄悄失灵。
   */
  it('纸上印的页边线/版心框不吃指针，且这条规矩不按纸分别写', () => {
    const bare = [...CSS.matchAll(/(^|\n)([^{}\n]*::before[^{}\n]*)\{([^}]*)\}/g)]
      .map((m) => ({ sel: m[2].trim(), body: m[3].replace(/\/\*[\s\S]*?\*\//g, ' ') }))
      .find((r) => /pointer-events:\s*none/.test(r.body)
        && /(^|,)\s*\.ndd-pad::before/.test(r.sel) && /\.ndd-peel::before/.test(r.sel));
    expect(bare, '找不到给 .ndd-pad::before / .ndd-peel::before 关掉指针的那条规则').toBeTruthy();
    expect(bare.sel, '这条不许被限定到某一种纸上 —— 新加一种纸就会漏').not.toMatch(/\.nd-sheet-/);
    // 反向：别处再把它开回来（伪元素默认就是吃指针的，写 auto 等于原地复活这个 bug）
    for (const m of CSS.matchAll(/([^{}\n]*::before[^{}\n]*)\{([^}]*)\}/g)) {
      expect(m[2], `${m[1].trim()} 里把 pointer-events 开回来了`).not.toMatch(/pointer-events:\s*(auto|all)/);
    }
  });

  it('SHEET_CLS 里的每个类名在 CSS 里都真有配方', () => {
    const tbl = SHEETS.match(/const SHEET_CLS = \{([^}]*)\}/)?.[1];
    expect(tbl, 'home-sheets.js 里找不到 SHEET_CLS').toBeTruthy();
    const cls = [...tbl.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(cls.length, 'SHEET_CLS 是空的？').toBeGreaterThanOrEqual(2);
    for (const c of cls) {
      expect(CSS.includes(`.${c} {`), `SHEET_CLS 指到 .${c}，但 CSS 里没有这份配方`).toBe(true);
    }
  });

  /**
   * ⭐ 用户 2026-08-28 的原话：「两个便签条在翻页的时候不要做出上下跳动」。
   *
   * 上一版靠"选中的高一档、没选的矮一档"假装谁在后面，于是每次切换两片签都上下跳。
   * 现在签**真的**在纸后面（.nd-tabs 是纸的兄弟且排在纸前面 = 被纸压住），
   * 深浅只由颜色表达 —— 所以选中/悬停那两条规则里**一个会挪动它的属性都不许有**。
   * 这条比"某个数等于某个数"值钱：它拦的是"下次谁又想加个 2px 抬升"。
   */
  const MOVERS = /(?:^|[;{\s])(padding|margin|top|bottom|left|right|width|height|transform|inset|font|line-height|letter-spacing|text-indent|border-radius|gap)[\w-]*\s*:/;

  it('选中那片只换颜色 —— 任何会挪动/改大小的属性都不许写进 .on', () => {
    const bad = on.match(MOVERS);
    expect(bad, `.nd-tabs > *.on 里写了 ${bad && bad[1]} —— 换模式时这片签会跳一下。`
      + '深浅只许用颜色/阴影表达').toBe(null);
  });

  it('悬停也只换颜色（签是被纸压着的，抬不起来）', () => {
    const bad = rule('.nd-tabs > *:not(.on):hover ').match(MOVERS);
    expect(bad, `悬停那条里写了 ${bad && bad[1]} —— 签在纸后面，动它就穿帮`).toBe(null);
  });

  it('签的下缘真的埋进纸里，且埋掉的那截不许吃到字', () => {
    const sink = -num(strip, 'margin-bottom');
    expect(sink, '.nd-tabs 得往下沉一段（负 margin-bottom），下缘才埋得进纸里').toBeGreaterThan(0);
    const padBottom = Number(off.match(/padding:\s*[\d.]+px\s+[\d.]+px\s+([\d.]+)px/)?.[1]);
    expect(padBottom, `签埋进纸里 ${sink}px，但下内边距只有 ${padBottom}px —— `
      + '埋掉的那截会啃到字').toBeGreaterThanOrEqual(sink);
  });

  /**
   * 页签要从纸的上沿探出来一截，问候语得让开这么多。
   * ⚠️ 窄屏那段媒体查询里**又写了一份** .ndd-greet 的 margin-bottom —— 08-28 就
   * 是漏了它：宽屏好好的，390 上页签直接压在问候语上（而且窄屏问候语会折行，
   * 顶得更明显）。同一个数散在两处、只有一处会被人改，是这个文件的常客。
   */
  it('**每一处** .ndd-greet 都给页签留够了地方（含媒体查询里那份）', () => {
    const NEED = 28;   // 签探出纸上沿约 26px，再留一点空气
    const found = [...CSS.matchAll(/\.ndd-greet\s*\{([^}]*)\}/g)]
      .map((m) => num(m[1].replace(/\/\*[\s\S]*?\*\//g, ' '), 'margin-bottom'))
      .filter((v) => v !== null);
    expect(found.length, '一处都没找到？.ndd-greet 改名了，这条 lint 要跟着改')
      .toBeGreaterThanOrEqual(2);
    const bad = found.filter((v) => v < NEED);
    expect(bad, `这几处问候语底部留白不足 ${NEED}px，页签会顶到字上：${JSON.stringify(bad)}`)
      .toEqual([]);
  });

  /**
   * 签和纸是一体的：纸被扯下去，它那片签得跟着走。
   *
   * ⛔ 这条是踩出来的，而且踩得很典型：把选择器从 .tabs 改名成 .nd-tabs 时漏了
   * 隐藏另一片的那行，于是复制品把**整对**签都显出来了 —— 屏幕上一对歪着飞的
   * 标签，看起来完全像"设计上就不该带签"，我据此把整个功能删了。
   * **改名漏掉一条规则，长得跟设计错误一模一样。** 所以两头都钉住：复制品里得有
   * 那条签，CSS 里得有那条隐藏规则。
   */
  it('被扯下去的那张纸带着自己那片签一起走', () => {
    const i = ENTRY.indexOf('ndd-peel');
    expect(i, 'home-quick-entry.jsx 里找不到那张复制品').toBeGreaterThan(0);
    expect(ENTRY.slice(i, i + 1200), '复制品里没有页签 —— 签和纸是一体的，纸被扯走签得跟着走')
      .toMatch(/className="nd-tabs"/);
    expect(CSS, '复制品只该显自己那一片签，另一片占位不显形 —— 少了这条会飞出去一整对')
      .toMatch(/\.ndd-peel \.nd-tabs > \*:not\(\.on\)\s*\{[^}]*visibility:\s*hidden/);
  });

  /**
   * 模型选择器 / 开工按钮这些也是**写在这张纸上**的，纸被扯走它们得一起掉。
   *
   * 08-28 一度把这排抬到复制品之上（z-index:7），理由是"不抬的话切换那一瞬工具会
   * 先消失半秒" —— 那是在治症状。真解法是复制品自带一份克隆。这条 lint 守两头：
   * 别再把真的那排抬出去，克隆那条路也别断。
   */
  it('工具栏跟着纸一起掉（既不许抬出去，克隆那条路也不许断）', () => {
    expect(rule('.ndd-pad .bar '), '.bar 又被抬到复制品之上了 —— 那会变成"纸走了工具还钉在原地"')
      .not.toMatch(/z-index/);
    expect(ENTRY, '找不到 cloneFoot —— 复制品没有工具栏，切换那一瞬整排会消失')
      .toMatch(/const cloneFoot = \(\)/);
    expect(ENTRY, '真工具栏得挂 footRef 才克隆得到').toMatch(/className="foot" ref=\{footRef\}/);
    expect(ENTRY, '克隆得真塞进复制品里').toMatch(/replaceChildren\(peel\.foot\)/);
    expect(ENTRY, '克隆里的 id 要摘掉，不然跟原件抢 SVG 的 url(#…) 引用')
      .toMatch(/removeAttribute\('id'\)/);
    expect(ENTRY, '克隆里的按钮要退出 Tab 顺序 —— aria-hidden 挡不住键盘焦点')
      .toMatch(/'tabindex', '-1'/);
    // 复制品在 DOM 上排在真工具栏**后面**：克隆的 id 虽然摘了，位置在后总归更稳
    expect(ENTRY.indexOf('ref={footRef}'), '复制品得排在真工具栏后面')
      .toBeLessThan(ENTRY.indexOf('ndd-peel'));
  });

  it('签在 DOM 上排在纸前面（不然它就压在纸上，"被压着"就成了假的）', () => {
    const iTabs = ENTRY.indexOf('className="nd-tabs" role="radiogroup"');
    const iPad = ENTRY.indexOf("className=\"ndd-pad\"");
    expect(iTabs, 'home-quick-entry.jsx 里找不到那条页签').toBeGreaterThan(0);
    expect(iPad, '找不到那张纸').toBeGreaterThan(0);
    expect(iTabs < iPad, '页签的 DOM 位置跑到纸后面去了 —— 它会盖在纸上面').toBe(true);
    // z-index 没有单位，num（只认带 px 的）读不出来
    const z = (body) => Number(body.match(/z-index:\s*(-?\d+)/)?.[1]);
    expect(z(rule('.ndd-stack > .nd-tabs ')), '签的 z 得比纸低')
      .toBeLessThan(z(rule('.ndd-pad ')));
  });

  /**
   * 桌上的项目卡和手里的输入栏得是**同一个世界的纸**：都读 .nd-sheet-* 那份配方。
   * 卡片这边最容易退化成"挂一枚徽记说这个是演出的" —— 那就又回到描边+填充那套
   * 语言里去了，而且徽记跟纸色是两处定义、迟早不一致。
   */
  it('项目卡跟输入栏读同一份配方（演出的卡就是稿纸，不是挂了牌的白纸）', () => {
    expect(HOME, 'Home.jsx 没给卡片挑配方类 —— 桌上就看不出哪些是演出项目')
      .toMatch(/sheetClassOf\(project\.mode\)/);
    const card = rule('.ndd-card > a ');
    expect(card.match(/background-color:\s*([^;]+)/)?.[1].trim(),
      '卡片的底色得读 --sheet，写死就跟输入栏那两种纸分家了').toBe('var(--sheet)');
    // 演出那张空白缩略图得真换过（红格线），不是跟设计共用一份
    expect(CSS, '演出项目的空白缩略图没换成稿纸 —— 有封面的卡靠纸色区分，没封面的靠格线')
      .toMatch(/\.nd-sheet-rp \.ndd-shot\.empty\s*\{/);
  });

  it('那枚胶囊已经拆干净（.ndd-mode 一处都不许剩）', () => {
    expect(CSS, '.ndd-mode 的样式还在 —— 它已经被页签替掉了').not.toMatch(/\.ndd-mode/);
    expect(ENTRY, 'home-quick-entry.jsx 里还挂着 ndd-mode').not.toMatch(/ndd-mode/);
  });
});
