// 线的几何与符号地图（2026-08-27 空间规划第一刀）
//
// 为什么钉：这一层的承诺是「模型声明拓扑，机器做几何」—— 开列撞了姊妹线、
// frontier 算错一格，版面就从"线"退化回"散点"，而模型对坐标是瞎的，它自己
// 发现不了。fallback 契约与 resolvePlacement 同款：没有失败分支。
import { describe, it, expect } from 'vitest';
import { allocateLaneColumn, laneSummaries, LANE_W, LANE_GUTTER } from './board-lanes.js';

describe('allocateLaneColumn', () => {
  const parent = { x: 0, y: 0, w: 200, h: 100 };

  it('branch：空板上紧贴岔出点右侧一沟开列，y 对齐岔出点', () => {
    const r = allocateLaneColumn({ parent, box: { w: 432, h: 200 } });
    expect(r).toEqual({ x: 200 + LANE_GUTTER, y: 0, w: LANE_W, fallback: false });
  });

  it('⭐ 姊妹线占道让开：两条 branch 不迎头相撞', () => {
    const first = allocateLaneColumn({ parent, box: { w: 432, h: 200 } });
    const second = allocateLaneColumn({
      parent, box: { w: 432, h: 200 },
      lanes: [{ x: first.x, w: first.w }],
    });
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.w);
    expect(second.fallback).toBe(false);
  });

  it('开窗撞障碍就往右挪（列起点那一段必须是空的）', () => {
    const r = allocateLaneColumn({
      parent, box: { w: 432, h: 200 },
      obstacles: [{ x: 296, y: 0, w: 100, h: 100 }],
    });
    expect(r.x).toBeGreaterThanOrEqual(396);   // 障碍右缘 + 身位之外
    expect(r.fallback).toBe(false);
  });

  it('fresh：从版图右缘开新列，y 对齐内容顶', () => {
    const r = allocateLaneColumn({
      parent: null, box: { w: 432, h: 200 },
      obstacles: [{ x: -50, y: 30, w: 1000, h: 500 }],
    });
    expect(r).toEqual({ x: 950 + LANE_GUTTER, y: 30, w: LANE_W, fallback: false });
  });

  it('⭐ 扫不到空列也不失败：退到内容底下并标 fallback', () => {
    const r = allocateLaneColumn({
      parent, box: { w: 432, h: 200 },
      obstacles: [{ x: 0, y: 0, w: 6000, h: 5000 }],
    });
    expect(r.fallback).toBe(true);
    expect(r.y).toBeGreaterThan(5000);
    expect(Number.isFinite(r.x)).toBe(true);
  });
});

describe('laneSummaries：符号地图', () => {
  const board = {
    lanes: { 主线: { x: 0, y: 0, w: 480 } },
    objects: {
      'notes/板书/a.md': { tag: '主线', x: 0, y: 0, h: 100 },
      'notes/板书/b.md': { tag: '主线', x: 0, y: 200, h: 80 },
      'notes/板书/c.md': { tag: '野线', x: 600, y: 0, h: 100 },
      'notes/板书/d.md': { tag: '野线', x: 600, y: 150, h: 100 },
      'notes/板书/solo.md': { tag: '独苗', x: 900, y: 0, h: 100 },
    },
  };

  it('已注册的线报节数 / 最新 / frontier（frontier 从成员现算，不存第二份）', () => {
    const l = laneSummaries(board).find((x) => x.tag === '主线');
    expect(l.registered).toBe(true);
    expect(l.count).toBe(2);
    expect(l.lastId).toBe('notes/板书/b.md');
    expect(l.frontier).toEqual({ x: 0, y: 200 + 80 + 24 });
  });

  it('⭐ 未登记但成串（≥2 件）的 tag 报成野线；单件 tag 不报', () => {
    const tags = laneSummaries(board).map((x) => x.tag);
    expect(tags).toContain('野线');
    expect(tags).not.toContain('独苗');
    expect(laneSummaries(board).find((x) => x.tag === '野线').registered).toBe(false);
  });

  it('空线（注册了还没落任何一条）frontier = 列头', () => {
    const l = laneSummaries({ lanes: { 新线: { x: 500, y: 40, w: 480 } }, objects: {} })[0];
    expect(l.count).toBe(0);
    expect(l.frontier).toEqual({ x: 500, y: 40 });
  });
});
