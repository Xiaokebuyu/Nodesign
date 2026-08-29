import { describe, it, expect } from 'vitest';
import { readingOrder, latestItem, readFocusOpts, currentIndex, stepItem } from './board-reading.js';
import { fitBox } from './board-camera.js';

const it_ = (id, x, y, w = 400, h = 200) => ({ id, x, y, w, h });

describe('阅读顺序', () => {
  it('纵向单列退化成从上到下', () => {
    const order = readingOrder([it_('c', 0, 900), it_('a', 0, 0), it_('b', 0, 450)]);
    expect(order.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('横向铺开的老板子读成「一行一行，行内从左到右」', () => {
    // 两行三列，故意打乱输入序
    const items = [
      it_('r2c2', 600, 400), it_('r1c1', 0, 0), it_('r2c1', 0, 400),
      it_('r1c3', 1200, 0), it_('r1c2', 600, 0), it_('r2c3', 1200, 400),
    ];
    expect(readingOrder(items).map((o) => o.id))
      .toEqual(['r1c1', 'r1c2', 'r1c3', 'r2c1', 'r2c2', 'r2c3']);
  });

  it('稍微错开的两件仍算同一行（真板子上没人对齐到像素）', () => {
    const order = readingOrder([it_('right', 600, 37), it_('left', 0, 0)]);
    expect(order.map((o) => o.id)).toEqual(['left', 'right']);
  });

  it('一件很高的东西旁边站着小卡：小卡算同一行，不该被甩到后面去', () => {
    // 判据拿较矮的那件当分母，否则 60 高的小卡对 900 高的板只重叠 6.7%，会分成两行
    const order = readingOrder([it_('tall', 0, 0, 400, 900), it_('chip', 600, 40, 200, 60)]);
    expect(order.map((o) => o.id)).toEqual(['tall', 'chip']);
  });

  it('上下真错开的两件是两行', () => {
    const order = readingOrder([it_('below', 600, 300, 400, 200), it_('above', 0, 0, 400, 200)]);
    expect(order.map((o) => o.id)).toEqual(['above', 'below']);
  });

  it('空集 / 单件不炸', () => {
    expect(readingOrder([])).toEqual([]);
    expect(readingOrder(null)).toEqual([]);
    expect(readingOrder([it_('only', 5, 5)]).map((o) => o.id)).toEqual(['only']);
  });
});

describe('开局对准谁', () => {
  const items = [it_('a', 0, 0), it_('b', 0, 400), it_('c', 0, 800)];

  it('取 board.objects 键序的最后一个（= 最后写出来的那件）', () => {
    expect(latestItem(['a', 'b', 'c'], items).id).toBe('c');
  });

  it('键序里那件已经不在画布上（删了 / 不在这一层）就往前找', () => {
    expect(latestItem(['a', 'b', 'c', 'ghost'], items).id).toBe('c');
    expect(latestItem(['a', 'zz', 'b'], [items[0], items[1]]).id).toBe('b');
  });

  it('键序整个对不上时兜底给第一件，不许回 null 让调用方去处理', () => {
    expect(latestItem(['x', 'y'], items).id).toBe('a');
    expect(latestItem([], [])).toBe(null);
  });
});

describe('「一件占满一屏」的取景', () => {
  const phoneVp = { w: 390, h: 664 };

  it('按宽取景不随内容变高而变小 —— 长块上这就是能读和不能读的差别', () => {
    const readZ = (h) => fitBox({ x: 100, y: 100, w: 450, h }, phoneVp, readFocusOpts('phone')).z;
    const wholeZ = (h) => fitBox({ x: 100, y: 100, w: 450, h }, phoneVp, { maxZoom: 1 }).z;
    // 按宽：390 宽的屏减去两边 10 → 370/450 = 0.822，跟高度无关
    expect(readZ(150)).toBeCloseTo(0.822, 2);
    expect(readZ(1800)).toBeCloseTo(0.822, 2);
    // 整件入镜随高度掉下去：短块几乎一样，长块只剩 0.34（16px 正文 → 5.5px）
    expect(wholeZ(150)).toBeCloseTo(0.76, 2);
    expect(wholeZ(1800)).toBeCloseTo(0.342, 2);
    expect(readZ(1800) / wholeZ(1800)).toBeGreaterThan(2);
  });

  it('顶对齐：这块的上沿落在视口上沿 + 内边距，从开头读起', () => {
    const box = { x: 100, y: 700, w: 450, h: 900 };
    const cam = fitBox(box, phoneVp, readFocusOpts('phone'));
    // 屏幕 y = (世界 y + cam.y) * z
    const screenTop = (box.y + cam.y) * cam.z;
    expect(screenTop).toBeCloseTo(10, 1);
  });

  it('小卡片放得大一点才占得住一屏（手机 1.6 倍上限）', () => {
    const cam = fitBox({ x: 0, y: 0, w: 200, h: 120 }, phoneVp, readFocusOpts('phone'));
    expect(cam.z).toBeCloseTo(1.6, 2);
  });

  it('axis:x 不改桌面行为 —— 缺省仍是两轴都装得下', () => {
    const box = { x: 0, y: 0, w: 400, h: 2000 };
    const desktop = fitBox(box, { w: 1600, h: 950 });
    expect(desktop.z).toBeCloseTo((950 - 48) / 2000, 3);
    // 居中仍是居中
    expect((box.y + desktop.y) * desktop.z + (box.h * desktop.z) / 2).toBeCloseTo(950 / 2, 1);
  });
});

describe('翻件', () => {
  const order = [it_('a', 0, 0), it_('b', 0, 400), it_('c', 0, 800)];
  const centerOf = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

  it('按离视口中心最近的那件定位「现在读到哪」', () => {
    expect(currentIndex(order, centerOf(order[1]))).toBe(1);
    // 稍微偏一点仍然是它
    expect(currentIndex(order, { x: 210, y: 480 })).toBe(1);
  });

  it('往下 / 往上各翻一件', () => {
    expect(stepItem(order, centerOf(order[0]), 1).id).toBe('b');
    expect(stepItem(order, centerOf(order[2]), -1).id).toBe('b');
  });

  it('到头就停，不绕回去 —— 画布不是轮播', () => {
    expect(stepItem(order, centerOf(order[2]), 1)).toBe(null);
    expect(stepItem(order, centerOf(order[0]), -1)).toBe(null);
  });

  it('空板不炸', () => {
    expect(currentIndex([], { x: 0, y: 0 })).toBe(-1);
    expect(stepItem([], { x: 0, y: 0 }, 1)).toBe(null);
  });
});
