/**
 * 首页台面（.ndd / .ndd::before）的硬约束（2026-08-28 性能案）。
 *
 * 用户报「项目数一超过某个量首页就奇卡无比」。真机 trace 实测：台面那十四层背景
 * 原来画在 .ndd 自己身上，而 .ndd 的高度**随项目数线性增长**（32 张卡 2825px）。
 * 浏览器按 tile 栅格，每滚出一块新 tile 就把十四层重新合成一遍 ——
 * 每块 tile 恒定 ~13ms（正常远低于 1ms），卡片少到不出现滚动条时一次都不用画，
 * 一旦要滚就是全价。同靶子 A/B（exp 23 张卡）：修前 619/304ms，修后 45.8/45.4ms。
 *
 * 修法是把整片台面搬进一个**视口大小的固定层**。注释拦不住任何人（同仓规矩：
 * 契约要配 lint），所以钉在这儿 —— 三条都是「改回去就会重新变卡」的判据。
 *
 * ⛔ 特别钉住 background-attachment: fixed：那是看起来最省事的改法，实测
 *    6644ms / 1604 块 tile，**比原样还差 12 倍**。
 */
import { describe, it, expect } from 'vitest';
import { CSS } from './home-styles.js';

/**
 * ⚠️ 判据要先剥注释：第一版直接 match 整份 CSS，被**我自己写在注释里**的
 * 「background-attachment: fixed」那句话咬中了（那句话正是在告诫别用它）。
 * 判据读的必须是真生效的声明，不是解释它的文字。
 */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某个选择器的规则体（够用即可：这份 CSS 是手写的，选择器不重名） */
function ruleOf(sel) {
  const i = CODE.indexOf(`${sel} {`);
  if (i < 0) return null;
  return CODE.slice(i, CODE.indexOf('}', i));
}

describe('首页台面不许再随内容长高', () => {
  it('⭐ .ndd::before 必须是 position: fixed（视口大小），不能是 absolute', () => {
    const r = ruleOf('.ndd::before');
    expect(r, '.ndd::before 规则不见了').toBeTruthy();
    expect(r).toMatch(/position:\s*fixed/);
    expect(r, 'absolute + inset:0 = 铺满整个会长高的 .ndd，就是那个病').not.toMatch(/position:\s*absolute/);
  });

  it('⭐ .ndd 自己只留底色 —— 多层背景不许再挂回这个会长高的容器上', () => {
    const r = ruleOf('.ndd');
    expect(r).toBeTruthy();
    const bg = /background:([^;]*);/.exec(r)?.[1] || '';
    expect(bg).toMatch(/var\(--wall\)/);
    expect(bg, '渐变/颗粒/网格线要住在固定层里，不是这里').not.toMatch(/gradient|--grain/);
  });

  it('⛔ 不许出现 background-attachment: fixed（实测比不改还差 12 倍）', () => {
    // ⚠️ 只禁 fixed。同文件 .ndd-pad 的 `local` 是另一回事且必须留着 ——
    // 横线要跟着 textarea 的内容一起滚（见 home-pad.lint.test.js）
    expect(CODE).not.toMatch(/background-attachment:\s*fixed/);
    expect(CODE, '横线本那条 local 不该被误伤').toMatch(/background-attachment:\s*local/);
  });

  it('台面那十四层一层都没丢（修的是画在哪，不是删设计）', () => {
    const r = ruleOf('.ndd::before');
    const count = (re) => (r.match(re) || []).length;
    expect(count(/radial-gradient\(ellipse/g), '五个渐变打光').toBe(5);
    expect(count(/radial-gradient\(circle/g), '三个旧钉眼').toBe(3);
    expect(count(/repeating-linear-gradient/g), '两条方格 + 两条织纹').toBe(4);
    expect(r, '纸面颗粒').toMatch(/var\(--grain\)/);
  });
});
