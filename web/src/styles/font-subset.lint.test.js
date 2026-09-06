/**
 * 楷体字集的硬约束（2026-08-29 混排案）。
 *
 * 病：楷体只切过一份 52KB 子集，字表是 08-07 从登录墙扫的 330 个字。之后每写一页
 * 界面就多一批字掉在外面 —— CSS 的字体回退是**逐字**的，掉出去的那个字自己去找
 * 系统字体，于是一行里楷体宋体混着排。08-29 实测：首页 144 个字在退化，登录墙
 * 自己也已经有 28 个。板书那次「不适合阅读」是同一个病的另一半。
 *
 * 修法是两级字集（globals.css 里有完整说明）+ 一张兜底网（theme.js 的字体栈）。
 * 注释拦不住任何人（同仓规矩：契约要配 lint），所以钉在这儿：四条都是
 * 「改回去就会重新出现宋体」的判据。
 *
 * ⚠️ 判据本身要先验一遍：这份 lint 不读字表快照，而是现场调
 * `web/scripts/gen-font-subset.py --report` 去读 woff2 真实的 cmap —— 快照会跟字体
 * 文件各自漂移，那正是这个 bug 本来的形状。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const CSS = readFileSync(resolve(HERE, 'globals.css'), 'utf8');
const THEME = readFileSync(resolve(HERE, '../lib/theme.js'), 'utf8');

/** 现场读字体文件（python3-fonttools）。缺依赖就红 —— 静默跳过的 lint 等于没有。 */
const report = JSON.parse(execFileSync('python3', [
  resolve(ROOT, 'web/scripts/gen-font-subset.py'), '--report',
], { encoding: 'utf8', cwd: ROOT }));

/** 取出 family = 'LXGW WenKai ND' 的每一段 @font-face（按声明先后） */
const FACES = [...CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)]
  .map(m => m[1])
  .filter(b => /font-family:\s*'LXGW WenKai ND'/.test(b))
  .map(b => ({
    src: (b.match(/url\('([^']+)'\)/) || [])[1] || '',
    weight: (b.match(/font-weight:\s*(\d+)/) || [])[1] || '',
    range: (b.match(/unicode-range:\s*([^;]+);/) || [])[1]?.trim() || null,
  }));

describe('楷体字集不许再漏字', () => {
  it('⭐ 界面上会出现的汉字，必须全在全站字集里（漏掉的那个字会变宋体）', () => {
    const han = report.missing.filter(c => c >= '一' && c <= '鿿');
    expect(han, `这些字不在 lxgw-nd-app-*.woff2 里，会逐字回退到系统宋体：${han.join('')}\n`
      + '改完界面文案要重跑 python3 web/scripts/gen-font-subset.py').toEqual([]);
  });

  it('⭐ 首屏字集必须带 unicode-range，且跟它 woff2 的真实 cmap 一字不差', () => {
    const first = FACES.filter(f => /lxgw-nd-(regular|bold)\.woff2$/.test(f.src));
    expect(first, '首屏字集那两段 @font-face 不见了').toHaveLength(2);
    for (const f of first) {
      // 不写 unicode-range = 声明"我覆盖所有字符"，浏览器选中它、发现没这个字形，
      // 就跳出整个 family 去系统字体 —— 全站字集那两段永远不会被用到。
      expect(f.range, `${f.src} 少了 unicode-range，全站字集会被它挡死`).toBeTruthy();
      expect(f.range).toBe(report.firstRange);
    }
  });

  it('⭐ 全站字集不带 unicode-range，且必须声明在首屏字集之前（后声明的赢）', () => {
    const idxApp = FACES.findIndex(f => /app-regular/.test(f.src));
    const idxFirst = FACES.findIndex(f => /lxgw-nd-regular\.woff2$/.test(f.src));
    expect(idxApp, 'lxgw-nd-app-regular.woff2 那段 @font-face 不见了').toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxApp, '顺序反了：首屏字集要排在后面才拿得到它那 330 个字').toBeLessThan(idxFirst);
    for (const f of FACES.filter(x => /app-(regular|bold)/.test(x.src))) {
      expect(f.range, '全站字集加了 unicode-range 就不再是兜底').toBeNull();
    }
    expect(report.weightsMatch, 'regular 和 bold 的字表不一致，粗体会漏字').toBe(true);
  });

  it('⭐ 字体栈里必须留一张全覆盖的网，排在 serif 之前', () => {
    // 09-06 起真栈在 globals.css 的 --nd-font-ui（设置页「外观」按 data-font 切），theme 的 FONT_KAI 只是 var()
    expect(THEME, 'FONT_KAI 必须指向 CSS 变量，字体切换靠它').toMatch(/export const FONT_KAI = 'var\(--nd-font-ui\)'/);
    const kai = (CSS.match(/:root\s*\{[^}]*--nd-font-ui:\s*([^;]+);/) || [])[1];
    expect(kai, '找不到 globals.css 里 :root 的 --nd-font-ui').toBeTruthy();
    expect(kai.indexOf("'LXGW WenKai ND'"), 'ND 必须排第一').toBe(0);
    // 用户自己打的字（项目名/文件名）超出全站字集时，接住它的是 Screen 那份全量字库；
    // 没有这一档就直接掉到 serif = 系统宋体。
    expect(kai, "少了 'LXGW WenKai Screen' 兜底").toContain("'LXGW WenKai Screen'");
    expect(kai.indexOf("'LXGW WenKai Screen'")).toBeLessThan(kai.indexOf('serif'));
  });
});
