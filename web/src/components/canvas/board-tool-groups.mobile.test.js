/**
 * 工具栏在三档设备上留下哪几颗（2026-08-28 移动端第二轮，2026-08-31 平板归队）。
 *
 * 这几条守的不是"好看"，是两件会悄悄坏掉的事：
 *   1. 手机上摆着**按了没反应**的按钮（指针/文字/涂鸦那一组）——
 *      比没有更坏，用户会以为是自己点不准；
 *   2. 手机上那条工具栏折成两行常驻，吃掉屏幕底部一大块。折行的主因是中文标签，
 *      而"撤标签"这件事有个一撤就废的例外：没有图标的那颗（缩放百分比）。
 *
 * ⭐ 08-31：平板不再跟着手机一起挨刀。判据从"是不是触屏"换成"是不是手机"，
 * 因为按不出反应的根源是「单指按在哪儿都推画面」，而那条规矩现在只留给手机
 * （390 宽的屏上没有空地可按）。改这里之前先读 useBoardCamera 的函数头。
 */
import { describe, it, expect } from 'vitest';
import { buildBoardToolGroups } from './board-tool-groups.js';

const build = (deviceClass, extra = {}) => buildBoardToolGroups({
  tool: 'select', setTool: () => {}, drawMode: 'ink', setDrawMode: () => {}, scale: 0.84,
  zoomFit: () => {}, zoomBy: () => {}, zoomTo: () => {},
  chalkEditMode: false, toggleChalkEdit: () => {},
  openCanvasNote: () => {},
  deviceClass, ...extra,
});
const idsOf = (groups) => groups.flatMap((g) => (g.items || []).map((i) => i.id));
const groupIds = (groups) => groups.map((g) => g.id);

describe('工具栏按设备档收敛', () => {
  it('桌面一颗不少（这一轮不许动桌面）', () => {
    const ids = idsOf(build('desktop'));
    for (const id of ['fit', 'zoomOut', 'zoomLevel', 'zoomIn', 'chalkEdit', 'canvasNote', 'select', 'text', 'draw']) {
      expect(ids, `桌面上少了 ${id}`).toContain(id);
    }
  });

  it('⛔ 手机上撤掉指针/文字/涂鸦 —— 它们在手机上按了没有任何反应', () => {
    // 病根在 useBoardCamera：手机保留「单指按在哪儿都推画面」，落不了笔也选不中
    const ids = idsOf(build('phone'));
    expect(ids, '手机还留着 select').not.toContain('select');
    expect(ids, '手机还留着 text').not.toContain('text');
    expect(ids, '手机还留着 draw').not.toContain('draw');
    expect(groupIds(build('phone')), '手机还留着 tools 组').not.toContain('tools');
  });

  it('⭐ 平板拿回这三颗（08-31：单指归工具那条规矩让它们真的能按了）', () => {
    const ids = idsOf(build('tablet'));
    for (const id of ['select', 'text', 'draw']) {
      expect(ids, `平板上少了 ${id} —— 08-31 起它在平板上是能按的`).toContain(id);
    }
    expect(groupIds(build('tablet'))).toContain('tools');
  });

  it('拿着笔的子模式组：桌面和平板有，手机没有（手机上那个态到不了）', () => {
    expect(groupIds(build('desktop', { tool: 'draw' }))).toContain('drawMode');
    expect(groupIds(build('tablet', { tool: 'draw' }))).toContain('drawMode');
    expect(groupIds(build('phone', { tool: 'draw' }))).not.toContain('drawMode');
  });

  it('手机再撤两颗：缩放的 − 和 +（捏合是更自然的那条路）', () => {
    const phone = idsOf(build('phone'));
    for (const id of ['zoomOut', 'zoomIn']) {
      expect(phone, `手机上还留着 ${id}`).not.toContain(id);
    }
    const tablet = idsOf(build('tablet'));
    for (const id of ['zoomOut', 'zoomIn']) {
      expect(tablet, `平板不该撤 ${id}`).toContain(id);
    }
  });

  /**
   * ⭐⭐ 2026-08-31 站主拍板：「黑板」下架，那一格换成「板书可移动」。
   *
   * 黑板是 08-23 的遗留 —— 那时"画布取代侧栏"是一件要选的事，今天它就是这个产品
   * 本身。实证：全库 ui-config.json 里写过 blackboard_mode 的项目 0 个。
   *
   * ⚠️ 改板书这一格**三档都要有**，而且它跟 useBoardObjectDrag 是绑死的：
   * 08-29「板书一律不给拖」的理由原文就是「那颗按钮手机上撤掉了」。按钮回来了闸就
   * 得解除，只改一处就是一个按了没反应的假开关。那一头的判据在 touch-drag.lint.test.js。
   */
  it('⛔ 「黑板」哪一档都不许再出现', () => {
    for (const cls of ['phone', 'tablet', 'desktop']) {
      expect(idsOf(build(cls)), `${cls} 上又冒出了 blackboard`).not.toContain('blackboard');
    }
  });

  it('⭐ 「改板书」三档都要有（手机那一格是黑板腾出来的）', () => {
    for (const cls of ['phone', 'tablet', 'desktop']) {
      expect(idsOf(build(cls)), `${cls} 上没有改板书 —— 板书就永远动不了`).toContain('chalkEdit');
    }
  });

  /**
   * 「整理」2026-08-31 整颗下架 —— 这条不是设备档，是**哪一档都不许再有**。
   *
   * 它删的是根层物件的整条布局记录（tag / by / seat / 实测 w,h 一起没），而版面
   * 归属今天分属 agent（seat:'agent'）、用户（seat:'user'）、暂存架（seat:'shelf'）
   * 三方，一键全局重排必然越过其中两份的界。真要再加一颗"整理"，先读
   * BoardCanvas.jsx 里那块墓碑注释。
   */
  it('⛔ 「整理」哪一档都不许再出现', () => {
    for (const cls of ['phone', 'tablet', 'desktop']) {
      expect(idsOf(build(cls)), `${cls} 上又冒出了 tidy`).not.toContain('tidy');
    }
  });

  it('手机上留下的这几颗是「只读 + 对话」需要的', () => {
    const phone = idsOf(build('phone'));
    for (const id of ['fit', 'zoomLevel', 'chalkEdit', 'canvasNote']) {
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
    expect(idsOf(build('tablet'))).toContain('chalkEdit');
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
