/**
 * 设备档一路走到落位（2026-08-28 移动端第二轮）。
 *
 * 这条链有三段，每段坏了都不报错、只是用户手机上收到一块读不了的东西：
 *   浏览器判档 → viewpoint-store 收下 → fitFor 出版式 → resolvePlacement 排版
 * 所以判据从「服务端收到什么」量到「落位落在哪」，不在中间任何一段停。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { setViewpoint, getViewpoint, describeDevice, _resetViewpoints } from '../projects/viewpoint-store.js';
import { fitFor, SKETCH_FIT, resolveTemplate, layoutNodes, textBox, UNIT } from './sketch-layout.js';
import { placeThread, nextSpotInSheet } from './board-sheets.js';

const vpOf = (device) => ({
  camera: { x: 0, y: 0, w: 1600, h: 950 }, zoom: 1, ...(device ? { device } : {}),
});
const PHONE = { class: 'phone', w: 390, h: 664, dpr: 3, coarse: true };
const TABLET = { class: 'tablet', w: 810, h: 1080, dpr: 2, coarse: true };
const DESKTOP = { class: 'desktop', w: 1600, h: 950, dpr: 1, coarse: false };

describe('视点里的设备档', () => {
  beforeEach(() => _resetViewpoints());

  it('原样收下三档', () => {
    for (const d of [PHONE, TABLET, DESKTOP]) {
      setViewpoint('p', vpOf(d));
      expect(getViewpoint('p').device.class).toBe(d.class);
    }
  });

  it('认不出的档当桌面 —— 宁可给手机一份桌面版式，也别给桌面一份 342 宽的窄条', () => {
    setViewpoint('p', vpOf({ class: 'watch', w: 390, h: 664 }));
    expect(getViewpoint('p').device.class).toBe('desktop');
  });

  it('⛔ 尺寸不像真屏幕就整个丢掉 device，不是夹到边界', () => {
    // 夹持在这儿是错的判法：一个夹出来的 8000 会变成 8000 宽的版式建议
    setViewpoint('p', vpOf({ class: 'phone', w: 999999, h: 5, coarse: true }));
    expect(getViewpoint('p').device).toBe(null);
    setViewpoint('p2', vpOf({ class: 'phone', w: 'x', h: 664, coarse: true }));
    expect(getViewpoint('p2').device).toBe(null);
  });

  it('老前端不报 device 也不炸（这条链要能灰度）', () => {
    setViewpoint('p', vpOf(null));
    expect(getViewpoint('p').device).toBe(null);
    expect(fitFor(getViewpoint('p')).lane).toBe('desktop');
  });

  it('人话只在触屏档说 —— 桌面是默认情况，说了是噪音', () => {
    expect(describeDevice({ device: PHONE })).toContain('手机');
    expect(describeDevice({ device: TABLET })).toContain('平板');
    expect(describeDevice({ device: DESKTOP })).toBe(null);
    expect(describeDevice(null)).toBe(null);
  });
});

describe('fitFor 出的版式', () => {
  it('手机：一件 = 一屏，宽 = 屏宽 − 48', () => {
    const f = fitFor(vpOf(PHONE));
    expect(f.lane).toBe('phone');
    expect(f.column).toBe(true);
    expect(f.w).toBe(342);
    expect(f.screen).toEqual({ w: 390, h: 664 });
    // 高度给到 1.6 屏：竖着滚是手机上读长内容的天然姿势，宽度才是硬约束
    expect(f.h).toBe(Math.round(664 * 1.6));
  });

  it('平板同一条规矩，只是屏幕大', () => {
    const f = fitFor(vpOf(TABLET));
    expect(f.lane).toBe('tablet');
    expect(f.column).toBe(true);
    expect(f.w).toBe(762);
  });

  it('桌面一个数都没变（这一轮不许动桌面）', () => {
    const f = fitFor(vpOf(DESKTOP));
    expect(f.lane).toBe('desktop');
    expect(f.column).toBe(false);
    expect(f.w).toBe(2133);      // 1600 / 0.75（纸范式 08-29 基准，见 lib/screen.js）
    expect(f.h).toBe(1267);      // 950 / 0.75（四舍五入）
  });

  it('⭐ 屏幕像素跟缩放无关 —— 用户缩到 0.3 倍，版式建议不该跟着变', () => {
    const zoomed = { camera: { x: 0, y: 0, w: 1300, h: 2213 }, zoom: 0.3, device: PHONE };
    expect(fitFor(zoomed).w).toBe(342);
  });

  it('没有 device 时退回相机×缩放那条老路（08-23 起就在这么算）', () => {
    expect(fitFor({ camera: { x: 0, y: 0, w: 2000, h: 1187 }, zoom: 0.8 }).w).toBe(2133);   // 屏 1600 / 0.75
    // 什么都没有 → SKETCH_FIT 缺省
    expect(fitFor(null).w).toBe(SKETCH_FIT.w);
    expect(fitFor(null).lane).toBe('desktop');
  });
});

describe('单列落位（2026-08-29 纸范式：竖排是结构保证不是启发式）', () => {
  const box = { w: 342, h: 200 };

  it('线程接楼永远正下方（没有横接档 —— replyDir/挑侧启发式已随落位引擎退役）', () => {
    const replyTo = { x: 0, y: 0, w: 342, h: 200 };
    const r = placeThread({ sheets: {} }, replyTo, box, { obstacles: [{ ...replyTo }] });
    expect(r.y).toBeGreaterThanOrEqual(replyTo.y + replyTo.h);
    expect(r.x).toBe(replyTo.x);
  });

  it('接楼压住别人就跳到那件底下接着排（只往下，不换侧）', () => {
    const replyTo = { x: 0, y: 0, w: 342, h: 200 };
    const blocker = { x: 0, y: 224, w: 342, h: 300 };
    const r = placeThread({ sheets: {} }, replyTo, box, { obstacles: [replyTo, blocker] });
    expect(r.x).toBe(0);
    expect(r.y).toBeGreaterThanOrEqual(blocker.y + blocker.h);
  });

  it('纸内顺排只往下（手机纸窄 = 天然单列，比纸宽的进不了纸）', () => {
    const b = { sheets: { p1: { x: 0, y: 0, w: 342 + 48, h: 1062 } }, objects: {} };
    const first = nextSpotInSheet(b, 'p1', box);
    expect(first).toBeTruthy();
    expect(nextSpotInSheet(b, 'p1', { w: 600, h: 100 })).toBeNull();   // 比手机纸宽 → 拒
  });
});

describe('单列版式下沉到布局引擎', () => {
  // 真会话逼出来的一条：模型收到「≤342 宽」之后传 w:14 想收窄，结果 flow 把节点
  // 横着摊成一排，整体反而从 549 变成 576 —— 它够着的杠杆是坏的
  const nodes = [
    { key: 'a', text: '选米泡米', w: 336, h: 110 },
    { key: 'b', text: '火候', w: 336, h: 136 },
    { key: 'c', text: '收尾', w: 336, h: 110 },
  ];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];

  it('桌面：有线且 ≥3 节点还是 flow（这一轮不许动桌面）', () => {
    expect(resolveTemplate(nodes, { template: 'auto', edges })).toBe('flow');
  });

  it('触屏：auto 一律竖排一列', () => {
    expect(resolveTemplate(nodes, { template: 'auto', edges, column: true })).toBe('column');
  });

  it('⭐ 连模型点名的模板也盖掉 —— 版面能不能读，不该由它配合与否决定', () => {
    for (const t of ['flow', 'row', 'grid', 'mindmap', 'free']) {
      expect(resolveTemplate(nodes, { template: t, edges, column: true }), `${t} 没被盖掉`).toBe('column');
      // 对照：桌面照旧听它的
      expect(resolveTemplate(nodes, { template: t, edges })).toBe(t);
    }
  });

  it('column 收得住 flow 收不住的那一种：无连线的节点在 flow 里跟第一层并排', () => {
    // ⭐ 真会话那 549 宽的机制在这儿：标题节点没有任何连线 → layoutFlow 把它判到
    // 第 0 层，跟 mi 肩并肩摊开（200 + 309 = 549）。纯链反而是竖的 —— 所以
    // 「flow 一定横着摊」是错的直觉，真正的风险是**同层多件**。
    const withTitle = [{ key: '__title', text: '标题', w: 200, h: 43 }, ...nodes];
    const widthOf = (pos, list) => {
      const xs = [...pos.entries()].map(([k, p]) => p.x + list.find(n => n.key === k).w);
      return Math.max(...xs) - Math.min(...[...pos.values()].map(p => p.x));
    };
    expect(widthOf(layoutNodes(withTitle, { template: 'flow', edges }), withTitle)).toBeGreaterThan(500);
    expect(widthOf(layoutNodes(withTitle, { template: 'column', edges }), withTitle)).toBe(336);
  });

  it('⛔ 封顶要对**两条产出路径**都成立（板书和草图）', () => {
    // 第一次真会话只封了草图：草图乖乖 336，板书照旧 432（三档回落的上限 18×24）。
    // 这条钉的是「一个封顶函数、两处调用」这个形状 —— 加第三种产出时别再漏一条。
    const src = fs.readFileSync(path.join(HERE, '../engine/mcp/tools/write-on-board.js'), 'utf8');
    const uses = src.match(/capW\(/g) || [];
    expect(uses.length, 'capW 少于两处调用 —— 板书或草图有一条没过封顶').toBeGreaterThanOrEqual(2);
    expect(src, '封顶得从 fit.column 来，别在某一条路上写死').toMatch(/capUnits = fit\.column/);
  });

  it('⛔ 宽度封顶要走 wUnits，不能事后夹 w —— 高度是按宽度回推行数算的', () => {
    const long = '这是一段很长的正文'.repeat(12);
    const wide = textBox(long, 'md', { md: false, wUnits: null });
    const capped = textBox(long, 'md', { md: false, wUnits: Math.floor(342 / UNIT) });
    expect(capped.w).toBeLessThanOrEqual(342);
    // 变窄了行数就该变多、框就该变高。只夹 w 的话高度还是宽版那个 → 文字溢出框外
    expect(capped.h).toBeGreaterThan(wide.h);
  });
});
