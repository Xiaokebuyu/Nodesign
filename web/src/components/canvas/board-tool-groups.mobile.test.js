/**
 * 工具栏在三档设备上留下哪几颗（2026-08-28 移动端第二轮）。
 *
 * 这几条守的不是"好看"，是两件会悄悄坏掉的事：
 *   1. 触屏上摆着**按了没反应**的按钮（指针/文字/涂鸦那一组）——
 *      比没有更坏，用户会以为是自己点不准；
 *   2. 手机上那条工具栏折成两行常驻，吃掉屏幕底部一大块。折行的主因是中文标签，
 *      而"撤标签"这件事有个一撤就废的例外：没有图标的那颗（缩放百分比）。
 */
import { describe, it, expect } from 'vitest';
import { buildBoardToolGroups } from './board-tool-groups.js';

const build = (deviceClass, extra = {}) => buildBoardToolGroups({
  tool: 'select', setTool: () => {}, drawMode: 'ink', setDrawMode: () => {}, scale: 0.84,
  tidyBoard: () => {}, zoomFit: () => {}, zoomBy: () => {}, zoomTo: () => {},
  blackboardMode: false, toggleBlackboard: () => {},
  chalkEditMode: false, toggleChalkEdit: () => {},
  openCanvasNote: () => {},
  deviceClass, ...extra,
});
const idsOf = (groups) => groups.flatMap((g) => (g.items || []).map((i) => i.id));
const groupIds = (groups) => groups.map((g) => g.id);

describe('工具栏按设备档收敛', () => {
  it('桌面一颗不少（这一轮不许动桌面）', () => {
    const ids = idsOf(build('desktop'));
    for (const id of ['tidy', 'fit', 'zoomOut', 'zoomLevel', 'zoomIn', 'blackboard', 'chalkEdit', 'canvasNote', 'select', 'text', 'draw']) {
      expect(ids, `桌面上少了 ${id}`).toContain(id);
    }
  });

  it('⛔ 触屏上撤掉指针/文字/涂鸦 —— 它们在触屏上按了没有任何反应', () => {
    // 病根在 useBoardCamera 的 shouldPan：手指一落下就是推画面，落不了笔也选不中
    for (const cls of ['phone', 'tablet']) {
      const ids = idsOf(build(cls));
      expect(ids, `${cls} 还留着 select`).not.toContain('select');
      expect(ids, `${cls} 还留着 text`).not.toContain('text');
      expect(ids, `${cls} 还留着 draw`).not.toContain('draw');
      expect(groupIds(build(cls)), `${cls} 还留着 tools 组`).not.toContain('tools');
    }
  });

  it('拿着笔的子模式组在触屏上也不出现（那个态本来就到不了）', () => {
    expect(groupIds(build('desktop', { tool: 'draw' }))).toContain('drawMode');
    expect(groupIds(build('phone', { tool: 'draw' }))).not.toContain('drawMode');
    expect(groupIds(build('tablet', { tool: 'draw' }))).not.toContain('drawMode');
  });

  it('手机再撤四颗：整理 / 改板书 / 缩放的 − 和 +（用户拍板「只读 + 对话」）', () => {
    const phone = idsOf(build('phone'));
    for (const id of ['tidy', 'chalkEdit', 'zoomOut', 'zoomIn']) {
      expect(phone, `手机上还留着 ${id}`).not.toContain(id);
    }
    // 平板留着 —— 屏幕放得下
    const tablet = idsOf(build('tablet'));
    for (const id of ['tidy', 'chalkEdit', 'zoomOut', 'zoomIn']) {
      expect(tablet, `平板不该撤 ${id}`).toContain(id);
    }
  });

  it('手机上留下的这几颗是「只读 + 对话」需要的', () => {
    const phone = idsOf(build('phone'));
    for (const id of ['fit', 'zoomLevel', 'blackboard', 'canvasNote']) {
      expect(phone, `手机上少了 ${id}`).toContain(id);
    }
  });

  it('手机上按钮只留图标 —— 但没有图标的那颗必须留着标签', () => {
    for (const g of build('phone')) {
      for (const it of g.items || []) {
        if (it.icon) expect(it.label, `${it.id} 在手机上还带着标签，那是折行的主因`).toBeUndefined();
        else expect(it.label, `${it.id} 没有图标，撤了标签就是一颗空按钮`).toBeTruthy();
      }
    }
    // 平板和桌面照旧带标签
    expect(idsOf(build('tablet'))).toContain('tidy');
    expect(build('tablet').flatMap((g) => g.items || []).find((i) => i.id === 'fit').label).toBe('全部');
  });

  it('每颗都还留着 title —— 撤了标签之后它是唯一的自我说明', () => {
    for (const g of build('phone')) {
      for (const it of g.items || []) {
        if (it.icon) expect(it.title, `${it.id} 没有 title，撤了标签就成了哑巴按钮`).toBeTruthy();
      }
    }
  });

  it('自带 JSX 的组（漏斗 / 翻件）原样透传，不被撤标签那一步碰坏', () => {
    const filterGroup = { id: 'filter', node: 'FILTER' };
    const readGroup = { id: 'reading', node: 'PAGER' };
    const groups = build('phone', { filterGroup, readGroup });
    expect(groups.find((g) => g.id === 'filter')).toEqual(filterGroup);
    expect(groups.find((g) => g.id === 'reading')).toEqual(readGroup);
    // 翻件排在漏斗后面、视图组前面
    expect(groupIds(groups).slice(0, 3)).toEqual(['filter', 'reading', 'view']);
  });

  it('桌面不给翻件那一格（就算调用方传了也是它自己不传）', () => {
    expect(groupIds(build('desktop'))).not.toContain('reading');
  });
});
