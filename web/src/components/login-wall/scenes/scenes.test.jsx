/**
 * 三套场景的契约（09-12 印刷风改版）。
 *
 * 轮播的定时器按 STEPS 算「钉完没有、摘完没有」，而真正钉上去几张是场景里 .paper 的个数
 * （Scene.jsx 在运行时按 DOM 数）。两边对不上不报错：多了，最后几张还没钉完就被摘；
 * 少了，墙上空站着等。所以钉在这儿。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENES } from './index.js';
import { STEPS } from '../wall-css.js';

describe('登录页的三套场景', () => {
  it('三套，id 不重复', () => {
    expect(SCENES.length).toBe(3);
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(3);
  });

  for (const sc of SCENES) {
    it(`${sc.id}：正好 ${STEPS} 步，编号 1 到 ${STEPS} 各一个`, () => {
      const html = renderToStaticMarkup(sc.render());
      const papers = html.match(/class="paper[ "]/g) || [];
      expect(papers.length, `${sc.id} 的 .paper 有 ${papers.length} 个`).toBe(STEPS);
      const nos = [...html.matchAll(/class="no"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
      expect(nos).toEqual(Array.from({ length: STEPS }, (_, i) => i + 1));
    });

    it(`${sc.id}：每一步的位置都写在场景自己的 CSS 里（.sc-${sc.id} .sN）`, () => {
      for (let i = 1; i <= STEPS; i++) {
        expect(sc.css, `${sc.id} 缺 .s${i} 的位置`).toMatch(new RegExp(`\\.sc-${sc.id} \\.s${i} \\{`));
      }
    });
  }
});
