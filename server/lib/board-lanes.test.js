// 线的几何与符号地图（2026-08-27 空间规划第一刀）
//
// 为什么钉：这一层的承诺是「模型声明拓扑，机器做几何」—— 开列撞了姊妹线、
// frontier 算错一格，版面就从"线"退化回"散点"，而模型对坐标是瞎的，它自己
// 发现不了。开列 2026-08-29 起归纸（board-sheets.js）。
import { describe, it, expect } from 'vitest';
import { laneSummaries } from './board-lanes.js';

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
