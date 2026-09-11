import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOUR_STEPS, CARD, placeCard, usable } from './canvas-tour.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = { w: 1440, h: 900 };

/**
 * 引导卡的摆位是纯算术，但它的失败**只在小窗口上出现**：卡片被挤出屏幕，人看不见"下一步"，
 * 引导当场卡死。靠眼睛只能看见自己那块屏幕，所以这里把四个方向和夹紧都钉住。
 */
describe('引导卡摆在哪', () => {
  it('右边放得下就放右边', () => {
    const at = placeCard({ x: 200, y: 300, w: 300, h: 200 }, CARD, VIEW);
    expect(at.side).toBe('right');
    expect(at.x).toBe(200 + 300 + 20);
  });

  it('右边放不下就放左边', () => {
    const at = placeCard({ x: 1000, y: 300, w: 380, h: 200 }, CARD, VIEW);
    expect(at.side).toBe('left');
    expect(at.x + CARD.w).toBeLessThanOrEqual(1000 - 20);
  });

  it('左右都放不下就上下（目标横贯整屏，比如底边那条工具栏）', () => {
    const at = placeCard({ x: 20, y: 820, w: 1400, h: 40 }, CARD, VIEW);
    expect(at.side).toBe('above');
    expect(at.y + CARD.h).toBeLessThanOrEqual(820 - 20);
  });

  it('目标贴着顶边时改放下面', () => {
    const at = placeCard({ x: 20, y: 0, w: 1400, h: 60 }, CARD, VIEW);
    expect(at.side).toBe('below');
    expect(at.y).toBe(80);
  });

  it('⭐ 怎么都放不下（目标几乎占满屏）也要整张留在视口里', () => {
    const small = { w: 420, h: 380 };
    const at = placeCard({ x: 0, y: 0, w: 420, h: 380 }, CARD, small);
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.x + CARD.w).toBeLessThanOrEqual(small.w);
    expect(at.y + CARD.h).toBeLessThanOrEqual(small.h);
  });
});

/**
 * ⛔ 每一步指的都是**别的文件里的一个标记**。谁把标记改了、删了，引导会安静地指空气 ——
 * 页面不报错、测试不红，只有真跑一遍引导才看得见。所以这里反查一遍。
 */
describe('五步指的东西还在', () => {
  it('步骤表本身是完整的', () => {
    expect(TOUR_STEPS.length).toBe(5);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(5);
    for (const s of TOUR_STEPS) {
      expect(s.anchor, `${s.id} 没有 anchor`).toBeTruthy();
      expect(s.title && s.body, `${s.id} 缺文案`).toBeTruthy();
      expect(s.body.length, `${s.id} 正文太长，卡片装不下`).toBeLessThan(90);
    }
  });

  it('每一步的标记都能在它声明的那个文件里找到', () => {
    for (const s of TOUR_STEPS) {
      const file = path.join(SRC, s.src);
      expect(fs.existsSync(file), `${s.id}: 找不到 ${s.src}`).toBe(true);
      const text = fs.readFileSync(file, 'utf8');
      const sel = s.anchor.join(', ');
      // 选择器里可能有好几段（第一步那种 a, b, c；第三步是有序的两条），属性名都要在源码里出现
      for (const attr of sel.match(/\[([a-z-]+)/g) || []) {
        expect(text, `${s.id}: ${s.src} 里没有 ${attr.slice(1)} 这个标记`).toContain(attr.slice(1));
      }
      for (const m of sel.matchAll(/\[data-nd-tour="([a-z-]+)"\]/g)) {
        expect(text, `${s.id}: ${s.src} 里没有 data-nd-tour="${m[1]}"`).toContain(`data-nd-tour="${m[1]}"`);
      }
    }
  });

  /**
   * ⭐ 这条是实测逼出来的：第三步原来指着整张关系线 svg，圈出来是一个包住整屏的框 ——
   * 页面不报错、上面那些判据也全绿，只有真跑一遍才看得见"它圈了个寂寞"。
   */
  it('⭐ 铺满屏的东西不算圈得出来（第三步的前科）', () => {
    const view = { w: 1600, h: 1000 };
    expect(usable({ x: -6, y: -6, w: 2269, h: 1615 }, view), '整层铺满还当成目标').toBe(false);
    expect(usable({ x: 1155, y: 701, w: 652, h: 440 }, view), '一张产物卡该能圈').toBe(true);
    expect(usable({ x: 0, y: 0, w: 2, h: 2 }, view), '还没画出来的东西不该圈').toBe(false);
    // 横贯整屏但很薄的（底边工具栏）：宽超了、高没超，算数
    expect(usable({ x: 20, y: 940, w: 1560, h: 38 }, view)).toBe(true);
    // ⭐ 在屏幕外的不算：画布上的东西多半不在视野里，指着它讲话等于指空气
    expect(usable({ x: 399, y: 1543, w: 120, h: 25 }, view), '屏幕外的还当成目标').toBe(false);
    expect(usable({ x: -200, y: 400, w: 300, h: 200 }, view), '只露出一角也算露出来了').toBe(true);
  });
});
