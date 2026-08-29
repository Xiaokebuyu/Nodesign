import { describe, it, expect, vi } from 'vitest';
import { buildBreadcrumb } from './workspace-chrome.js';

describe('面包屑', () => {
  it('在根上只有项目名，且不可点（点它回根 = 已经在根，给个能点的假象反而怪）', () => {
    const c = buildBreadcrumb('高数地图', { cwd: '', crumbs: [] }, () => {});
    expect(c).toHaveLength(1);
    expect(c[0].label).toBe('高数地图');
    expect(c[0].onClick).toBeUndefined();
  });

  it('进了文件夹：项目名可点回根，中间层可点，最后一级不可点', () => {
    const goTo = vi.fn();
    const c = buildBreadcrumb('P', { cwd: 'b', crumbs: [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }] }, goTo);
    expect(c.map((x) => x.label)).toEqual(['P', '甲', '乙']);
    c[0].onClick(); expect(goTo).toHaveBeenLastCalledWith('');
    c[1].onClick(); expect(goTo).toHaveBeenLastCalledWith('a');
    expect(c[2].onClick, '最后一级是"你在这儿"，不可点').toBeUndefined();
  });

  /**
   * ⭐ 这条守的是触屏那颗 ‹：它拿**倒数第二级**当「上一层」，所以「最后一级
   * 不给 onClick」不只是视觉规矩 —— 顺手把它补全的话，返回键会指向自己。
   */
  it('倒数第二级永远可点 —— 触屏那颗 ‹ 就是拿它当上一层', () => {
    const goTo = vi.fn();
    for (const crumbs of [
      [{ id: 'a', title: '甲' }],
      [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }],
      [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }, { id: 'c', title: '丙' }],
    ]) {
      const c = buildBreadcrumb('P', { cwd: crumbs[crumbs.length - 1].id, crumbs }, goTo);
      expect(typeof c[c.length - 2].onClick, `${crumbs.length} 层时倒数第二级点不动`).toBe('function');
    }
  });

  it('boardUi 还没上报（刚进页面）也不炸', () => {
    expect(buildBreadcrumb('P', null, () => {})).toHaveLength(1);
    expect(buildBreadcrumb('P', {}, () => {})).toHaveLength(1);
  });
});
