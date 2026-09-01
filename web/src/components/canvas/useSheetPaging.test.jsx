// @vitest-environment happy-dom
/**
 * 翻页与藏页的真渲染判据（2026-09-01 叠纸刀 4）。
 *
 * ⚠️ 这一条不是在测 pilesOf 那份纯函数（那有 parity 测试管）。它测的是**接完线
 * 之后屏幕上到底还剩几件** —— 一摞纸叠起来之后，没在显示的那些页上的墨必须从
 * 物件清单里整个消失，而不是"画出来再盖住"。滤的位置也是判据的一部分：滤在入座
 * 之前，藏起来的卡连命中区都不留；滤在渲染那一步的话，点空白处会选中一张看不见
 * 的卡（08-31「贴着不画线」那次留过同一个坑）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useSheetPaging } from './useSheetPaging.js';
import { useVisibleObjects } from './useVisibleObjects.js';

/** 一摞两页（各写了一条板书）+ 旁边自己一摞的状态表 + 一张没认领页的散图 */
const SHEETS = {
  p1: { x: 0, y: 0, w: 800, h: 600, at: '01', stack: 'main', title: '第一拍' },
  p2: { x: 0, y: 0, w: 800, h: 600, at: '02', stack: 'main', title: '第二拍' },
  st: { x: 900, y: 0, w: 360, h: 240, at: '03', title: '状态表' },
};
const STACKS = { main: { title: '主线' } };
/** 画布原生物件（手写字 / 草图节点走这条），它们跟板书一样会认领页 */
const ink = (sheet) => ({ kind: 'text', data: { t: '一段话' }, w: 432, h: 200, ...(sheet ? { sheet } : {}) });
const LAYOUT = {
  'text:一': { x: 24, y: 24, ...ink('p1') },
  'text:二': { x: 24, y: 24, ...ink('p2') },
  'text:状态': { x: 924, y: 24, ...ink('st') },
  'text:散件': { x: 600, y: 400, ...ink(null) },          // 没认领任何一页
};

/** 入座之后的样子（claimFor 要从这儿找卡心） */
const POSITIONED = { current: [
  { id: 'text:二', native: true, type: 'text', pos: { x: 24, y: 24 }, w: 432, h: 200 },
  { id: 'text:状态', native: true, type: 'text', pos: { x: 924, y: 24 }, w: 360, h: 110 },
  { id: 'text:散件', native: true, type: 'text', pos: { x: 1400, y: 800 }, w: 200, h: 148 },
  // 产物：落在 main 那一摞的地盘上，但它不参与叠放，一页都不该认
  { id: 'assets/图.png', type: 'image', pos: { x: 300, y: 300 }, w: 200, h: 148 },
] };

/** 架上三件到货（键序 = 到货序，最后到的在最上面） */
const SHELF = { x: -400, y: 0 };
const SHELF_LAYOUT = {
  'assets/到货1.png': { x: -400, y: 0, seat: 'shelf' },
  'assets/到货2.png': { x: -400, y: 0, seat: 'shelf' },
  'assets/到货3.png': { x: -400, y: 0, seat: 'shelf' },
};

function harness(onRender, opts = {}) {
  return function Probe() {
    const paging = useSheetPaging({
      sheets: SHEETS, stacks: STACKS,
      positionedRef: POSITIONED, sizeOf: (o) => ({ w: o.w || 432, h: o.h || 200 }),
      layout: opts.shelf ? { ...LAYOUT, ...SHELF_LAYOUT } : LAYOUT,
      shelf: opts.shelf ? SHELF : null,
    });
    const objects = useVisibleObjects({
      tasks: [], artifacts: [], layout: LAYOUT, browse: null,
      filter: { categories: [], sources: [] }, showArchive: true, rolls: {}, paging,
    });
    onRender({ paging, ids: objects.map((o) => o.id) });
    return null;
  };
}

function mount(onRender, opts = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Probe = harness(onRender, opts);
  act(() => root.render(<Probe />));
  return () => act(() => root.unmount());
}

describe('叠纸：屏幕上到底还剩几件', () => {
  it('⭐ 缺省显示最新那一页，第一页的板书从物件清单里整个消失', () => {
    let last = null;
    const unmount = mount((r) => { last = r; });
    expect(last.ids).toContain('text:二');
    expect(last.ids).not.toContain('text:一');
    unmount();
  });

  it('⭐ 没认领页的散件和别的摞一件都不藏', () => {
    let last = null;
    const unmount = mount((r) => { last = r; });
    expect(last.ids).toContain('text:散件');
    expect(last.ids).toContain('text:状态');
    unmount();
  });

  /**
   * ⭐ 翻页有一段过渡（旧页滑出去、新页滑进来，像手机主屏那样），所以判据分两段：
   * **过渡期间两页都在屏幕上**（旧页要留着滑，藏了就是硬切），**过渡结束旧页消失**。
   * 只钉后半段的话，把过渡整个删掉测试照样绿 —— 那就等于没测到动画。
   */
  it('⭐ 往回翻一页：过渡期间新旧两页都在，滑完只剩新页', () => {
    vi.useFakeTimers();
    let last = null;
    const unmount = mount((r) => { last = r; });
    act(() => last.paging.flip('main', -1));
    expect(last.ids, '过渡期间旧页要留着滑出去').toEqual(
      expect.arrayContaining(['text:一', 'text:二']),
    );
    // 新页先摆在来的方向一屏之外，下一帧摆回 0 —— 滑动是 CSS 做的
    expect(last.paging.shiftOf({ sheet: 'p1' })).not.toBe(0);
    act(() => { vi.advanceTimersByTime(500); });
    expect(last.ids).toContain('text:一');
    expect(last.ids, '滑完旧页就该走').not.toContain('text:二');
    expect(last.paging.shiftOf({ sheet: 'p1' })).toBe(0);
    // 再往回翻已经到头，不循环
    act(() => last.paging.flip('main', -1));
    expect(last.ids).toContain('text:一');
    unmount();
    vi.useRealTimers();
  });

  it('⭐ 点名翻到某一页（agent 的 show / 目录点击走这条）', () => {
    let last = null;
    const unmount = mount((r) => { last = r; });
    let ok;
    act(() => { ok = last.paging.showSheet('p1'); });
    expect(ok).toBe(true);
    expect(last.ids).toContain('text:一');
    act(() => { last.paging.showSheet('不存在的纸'); });
    expect(last.ids).toContain('text:一');   // 点不中就不动
    unmount();
  });

  it('⭐ 拖完重认页：卡心落在哪一摞就归那一摞此刻显示的那一页', () => {
    let last = null;
    const unmount = mount((r) => { last = r; });
    // text:二 卡心 (240,124) 落在 main 那一摞里，此刻显示 p2
    expect(last.paging.claimFor('text:二')).toBe('p2');
    // 翻到第一页再放，认的就是 p1 —— 归属跟"他此刻看着哪一页"走，不跟几何走
    act(() => last.paging.flip('main', -1));
    expect(last.paging.claimFor('text:二')).toBe('p1');
    // 落在状态表那一摞
    expect(last.paging.claimFor('text:状态')).toBe('st');
    // ⭐ 一摞都没落进 → 空串 = 摘掉归属（合并语义下唯一表达得了删键的写法）
    expect(last.paging.claimFor('text:散件')).toBe('');
    // ⭐⭐ 产物压在这一摞的地盘上也不认领 —— 它不参与叠放，翻到哪一页都看得见
    expect(last.paging.claimFor('assets/图.png')).toBeUndefined();
    // 卡不在场 → undefined = 这一发别动它的归属
    expect(last.paging.claimFor('text:不在板上')).toBeUndefined();
    unmount();
  });

  it('左右换摞到头返回 null，换摞不改任何一摞翻到第几页', () => {
    let last = null;
    const unmount = mount((r) => { last = r; });
    act(() => last.paging.flip('main', -1));
    expect(last.paging.shownOf('main')).toBe('p1');
    expect(last.paging.neighbor('main', 1).name).toBe('st');
    expect(last.paging.neighbor('st', 1)).toBeNull();
    expect(last.paging.shownOf('main')).toBe('p1');
    unmount();
  });
});

describe('暂存架也是一摞（2026-09-01）', () => {
  it('⭐ 架上三件叠在一处，屏幕上只画最上面那件（最后到的）', () => {
    let last = null;
    const unmount = mount((r) => { last = r; }, { shelf: true });
    expect(last.paging.shelfCount).toBe(3);
    expect(last.paging.isShelfHidden('assets/到货3.png')).toBe(false);
    expect(last.paging.isShelfHidden('assets/到货1.png')).toBe(true);
    expect(last.paging.isShelfHidden('assets/到货2.png')).toBe(true);
    unmount();
  });

  it('⭐ 架那一摞照样上下翻找（它的页是物件不是纸）', () => {
    let last = null;
    const unmount = mount((r) => { last = r; }, { shelf: true });
    act(() => last.paging.flip('__shelf__', -1));
    expect(last.paging.isShelfHidden('assets/到货2.png')).toBe(false);
    expect(last.paging.isShelfHidden('assets/到货3.png')).toBe(true);
    unmount();
  });

  it('架上只有一件时谁都不藏；没有架时这条整个不参与', () => {
    let last = null;
    const unmount = mount((r) => { last = r; });      // 不带架
    expect(last.paging.shelfCount).toBe(0);
    expect(last.paging.isShelfHidden('assets/到货1.png')).toBe(false);
    unmount();
  });

  it('架进 piles，左右换摞够得着它', () => {
    let last = null;
    const unmount = mount((r) => { last = r; }, { shelf: true });
    expect(last.paging.piles.map(p => p.name)).toContain('__shelf__');
    // 架在 x=-400，纸群从 x=0 起 —— 它排在最左边
    expect(last.paging.piles[0].name).toBe('__shelf__');
    expect(last.paging.neighbor('__shelf__', -1)).toBeNull();
    unmount();
  });
});
