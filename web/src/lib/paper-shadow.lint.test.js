/**
 * 影子的契约（2026-09-01，太阳开始走的那天）。
 *
 * 影子从「烤死的六条偏移」改成了「由光源层每分钟写一遍的 CSS 变量」。这一改动
 * 有两个安静的坏法，都不报错、都只在某一类页面上才看得见：
 *
 *   1. **兜底丢了。** 站点上有整页不挂光源层的地方（登录墙、还没跑到 effect 的
 *      第一帧）。var() 没兜底的话，那些地方一张影子都没有 —— 而纸靠影子跟桌面
 *      分开，没影子就是一片白摊在一片米色上。
 *   2. **表之间漏了一档。** 影子有六档（far/mid/near/stack/stackHigh/tag），
 *      分在三张表里：几何、兜底、变量名。少写一处，那一档就永远停在下午三点，
 *      而它旁边的纸在转 —— 一屏之内两个太阳。
 *
 * 所以这里钉的是「三张表对得上」和「兜底逐字节没变」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAPER_SHADOW, LIFT, LIFT_VAR, castCss } from './paper.js';
import { castAt, lightAt } from './daylight.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIGHT = fs.readFileSync(path.join(HERE, '../routes/home-light.jsx'), 'utf8');
const HOME_CSS = fs.readFileSync(path.join(HERE, '../routes/home-styles.js'), 'utf8');
const OCCL = fs.readFileSync(path.join(HERE, '../routes/home-occluders.js'), 'utf8');
const DESK = fs.readFileSync(path.join(HERE, '../routes/desk.jsx'), 'utf8');

/**
 * 2026-09-01 之前那六条，**逐字节抄在这儿**。
 *
 * 它同时是两件事的定义：光源层没挂时该长什么样，以及登录墙的逐像素基线
 * （shot-auth.mjs）为什么可以不用重立。改这张表 = 承认那条基线要重立一次。
 */
const BEFORE = {
  far:  '-1px 1px 2px rgba(93,74,44,0.14), -1px 3px 5px rgba(93,74,44,0.09)',
  mid:  '-1px 2px 3px rgba(93,74,44,0.15), -3px 6px 12px rgba(93,74,44,0.15)',
  near: '-2px 3px 4px rgba(93,74,44,0.18), -6px 13px 26px rgba(93,74,44,0.22)',
  stack:     '-3px 6px 12px rgba(93,74,44,0.15)',
  stackHigh: '-6px 13px 26px rgba(93,74,44,0.22)',
  tag:       '-1px 2px 3px rgba(93,74,44,0.22)',
  // 09-01 真渲染那一刀新分出来的两档：数值跟 mid / near 一模一样，
  // 分出来只为了能单独降成接触影。所以「没挂光源层的地方一个字节没变」照旧成立。
  sheet:     '-1px 2px 3px rgba(93,74,44,0.15), -3px 6px 12px rgba(93,74,44,0.15)',
  sheetHigh: '-2px 3px 4px rgba(93,74,44,0.18), -6px 13px 26px rgba(93,74,44,0.22)',
};

describe('⛔ 每一档影子都要有兜底', () => {
  it('形如 var(--nd-lift-x, 一条真的影子)', () => {
    for (const [tier, css] of Object.entries(PAPER_SHADOW)) {
      const m = css.match(/^var\((--nd-lift-[a-z-]+),\s*(.+)\)$/);
      expect(m, `${tier} 不是 var(变量, 兜底) 的形状：${css}`).toBeTruthy();
      expect(m[1], `${tier} 的变量名跟 LIFT_VAR 对不上`).toBe(LIFT_VAR[tier]);
      // 兜底得是一条真影子，不能是 none / 空 / 0
      expect(m[2], `${tier} 的兜底不像影子`).toMatch(/px .*rgba\(/);
    }
  });

  it('⭐ 兜底逐字节等于太阳开始走之前那一版', () => {
    for (const [tier, want] of Object.entries(BEFORE)) {
      expect(PAPER_SHADOW[tier], `${tier} 的兜底变了`).toBe(`var(${LIFT_VAR[tier]}, ${want})`);
    }
  });
});

describe('⛔ 三张表要对得上', () => {
  it('几何 / 变量名 / 兜底，一档都不许漏', () => {
    const keys = (o) => Object.keys(o).sort();
    expect(keys(LIFT_VAR), 'LIFT_VAR 跟 LIFT 对不上').toEqual(keys(LIFT));
    expect(keys(PAPER_SHADOW), 'PAPER_SHADOW 跟 LIFT 对不上').toEqual(keys(LIFT));
    expect(keys(BEFORE), '这张历史表跟 LIFT 对不上').toEqual(keys(LIFT));
  });

  it('⭐ 写变量的那一头是遍历 LIFT_VAR，不是抄一遍名字', () => {
    // 抄名字的话，加一档影子时这儿会安静地漏掉它
    expect(LIGHT, 'home-light 没有遍历 LIFT_VAR').toMatch(/Object\.entries\(LIFT_VAR\)/);
    expect(LIGHT, 'home-light 卸载时没把变量摘干净').toMatch(/Object\.values\(LIFT_VAR\)/);
  });
});

describe('⛔ 引用的档位必须真的存在', () => {
  it('⭐ PAPER_SHADOW.某个不存在的档 = 那个元素一张影子都没有，而且不报错', () => {
    // 真事：ContextMenu 和 LinkPopover 从 08-08 起写的是 PAPER_SHADOW.high ——
    // 这个键从来就不存在，于是 React 拿到 undefined 直接跳过，两个浮层从来没有
    // 过影子。**打错一个档位名的后果不是报错，是安静地少一层空间感**，而档位
    // 从三个涨到六个之后，打错的概率只会更高。
    const bad = [];
    for (const f of walk(path.join(HERE, '..'))) {
      if (f.endsWith('paper-shadow.lint.test.js')) continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/PAPER_SHADOW\.([a-zA-Z]\w*)/g)) {
        if (!(m[1] in LIFT)) bad.push(`${path.relative(path.join(HERE, '..'), f)} 用了 PAPER_SHADOW.${m[1]}`);
      }
    }
    expect(bad, `这些档位不存在（可选的档位是 ${Object.keys(LIFT).join(' / ')}）`).toEqual([]);
  });
});

/** 全仓扫一遍 .js/.jsx */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.jsx?$/.test(e.name)) out.push(f);
  }
  return out;
}

describe('⛔ 遮挡图和降档表必须对齐', () => {
  /**
   * 两张表：home-occluders.js 说「哪些元素会被着色器投影」，home-light.jsx 说
   * 「哪些档位降成接触影」。分叉的后果是安静的：
   *   进了遮挡图却没降档 → 那张纸有两个影子（一个 CSS 画的，一个投出来的）
   *   降了档却没进遮挡图 → 那张纸一个影子都没有
   * 两种都不报错，都得靠眼睛在某个钟点撞见。
   */
  const tiers = [...LIGHT.matchAll(/const SHEET_TIERS = new Set\(\[([^\]]*)\]/g)][0]?.[1] || '';
  const demoted = [...tiers.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  it('降档表里的每一档都真的存在', () => {
    expect(demoted.length, '没找到 SHEET_TIERS').toBeGreaterThan(0);
    for (const t of demoted) expect(LIFT, `降了一个不存在的档 ${t}`).toHaveProperty(t);
  });

  it('⭐⭐ 降了档的那几档，只许台面上的纸用 —— 别的地方用了就会一点影子都没有', () => {
    // 第一版这条写的是「CSS 里有人在用就行」，**攻不动**：往降档表里塞一个 far
    // 照样绿，而 far 是全站 39 个浮层在用的档，降了它们全都没影子。
    // 真正的判据是「这一档的**每一个**引用点都在遮挡图管得着的地方」。
    const allowed = ['routes/home-styles.js', 'routes/desk.jsx'];
    const bad = [];
    for (const t of demoted) {
      let seen = 0;
      for (const f of walk(path.join(HERE, '..'))) {
        if (f.endsWith('paper-shadow.lint.test.js')) continue;
        const hits = [...fs.readFileSync(f, 'utf8').matchAll(new RegExp(`PAPER_SHADOW\\.${t}\\b`, 'g'))];
        if (!hits.length) continue;
        seen += hits.length;
        const rel = path.relative(path.join(HERE, '..'), f).replace(/\\/g, '/');
        if (!allowed.includes(rel)) bad.push(`${rel} 用了降过档的 ${t}（它不在遮挡图里，会一点影子都没有）`);
      }
      expect(seen, `${t} 降了档，但全仓没有一个人用它 —— 降的是空气`).toBeGreaterThan(0);
    }
    expect(bad).toEqual([]);
  });

  it('⭐ 进了遮挡图的选择器，CSS 里必须找得到', () => {
    // 选择器写错不会报错，只是那张纸从此不投影
    const sels = [...OCCL.matchAll(/\['([^']+)',\s*[\d.]+\]/g)].map((m) => m[1]);
    expect(sels.length, '没解析出 OCCLUDERS').toBeGreaterThan(0);
    for (const sel of sels) {
      const cls = sel.match(/\.[a-z-]+/gi) || [];
      for (const c of cls) {
        expect(`${HOME_CSS}${DESK}`, `遮挡图列了 ${sel}，但 ${c} 在样式里根本不存在`)
          .toContain(c);
      }
    }
  });
});

describe('castCss 拼出来的是合法的影子', () => {
  const tiers = Object.keys(LIFT);
  const at = (h, mo = 9) => castAt(lightAt('auto', new Date(2026, mo - 1, 15, h, 0)));

  it('全天全季每一档都拼得出来，没有 NaN', () => {
    for (const mo of [3, 6, 9, 12]) {
      for (let h = 0; h < 24; h += 2) {
        for (const t of tiers) {
          const css = castCss(at(h, mo), t);
          expect(css, `${mo}月${h}点 ${t} 出了 NaN：${css}`).not.toMatch(/NaN|undefined/);
          expect(css, `${mo}月${h}点 ${t} 形状不对：${css}`)
            .toMatch(/^-?[\d.]+px -?[\d.]+px [\d.]+px rgba\(\d+,\d+,\d+,[\d.]+\)(, .+)?$/);
        }
      }
    }
  });

  it('层数跟 LIFT 一样多 —— 少一层就少一层空气感', () => {
    for (const t of tiers) {
      expect(castCss(at(12), t).split('), ').length).toBe(LIFT[t].length);
    }
  });

  it('⭐ 白天的影子是暖褐的，只有夜里才往冷里揉', () => {
    expect(castCss(at(12), 'mid')).toContain('rgba(93,74,44,');
    expect(castCss(at(22), 'mid')).not.toContain('rgba(93,74,44,');
  });

  it('⭐ 影子跟着太阳换边：早上偏左下，傍晚偏右下', () => {
    // ⚠️ 09-02 桌子定为**朝北**（东在屏幕右边），所以太阳右→左、影子左→右。
    //   理由在 daylight.js 的 sunFrom()。这条守的是"两头必须分处两边"，
    //   朝向要是再改，这里跟着翻一次就行。
    expect(castCss(at(8), 'near').startsWith('-')).toBe(true);
    expect(castCss(at(17), 'near').startsWith('-')).toBe(false);
  });
});
