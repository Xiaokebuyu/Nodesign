/**
 * useStackNav —— 翻页器 + 目录的接线（2026-09-01 叠纸刀 5）
 *
 * ⭐ 翻页**不动相机**。叠纸之后「下一页」不在别的地方，它就在原地，换的是画哪
 * 一张 —— 这跟 ReadingPager 那套「飞过去看下一件」是两件不同的事，所以两个件
 * 各活各的：板上有叠起来的摞才出这一个，存量板（一张纸自己一摞）照旧走那个。
 *
 * 换摞才动相机：那是真的去别的地方。
 *
 * 目录是叠纸**必须配的**，不是锦上添花：一摞纸只画得出最上面那张，底下那几页在
 * 屏幕上完全不存在，缩小也看不见（它们本来就在同一块地上）。没有目录，用户找不
 * 回自己刚才读到的那一页。
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { currentPileOf } from '../../lib/board-paging.js';
import { useReadingNav } from './ReadingPager.jsx';
import StackPager from './StackPager.jsx';
import BoardIndex from './BoardIndex.jsx';

export function useStackNav({ paging, camera, cam, camApiRef, sheets }) {
  const [indexOpen, setIndexOpen] = useState(false);

  /** 视口中心此刻落在哪一摞里 */
  const center = useMemo(() => ({
    x: camera.viewport.w / 2 / cam.z - cam.x,
    y: camera.viewport.h / 2 / cam.z - cam.y,
  }), [camera.viewport.w, camera.viewport.h, cam]);
  const pile = useMemo(() => currentPileOf(paging.piles, center), [paging.piles, center]);

  const index = useMemo(() => {
    if (!pile) return -1;
    return pile.sheets.indexOf(paging.shownOf(pile.name));
  }, [pile, paging]);

  const flip = useCallback((dir) => { if (pile) paging.flip(pile.name, dir); }, [pile, paging]);

  /** 目录里点一行：翻到那一页，并把镜头带到那一摞（跨摞才是真的去别处） */
  const pick = useCallback((target, id) => {
    paging.showSheet(id);
    setIndexOpen(false);
    if (target.name !== pile?.name) {
      camApiRef.current?.noteTakeover();
      camApiRef.current?.flyToBox({ x: target.x, y: target.y, w: target.w, h: target.h }, { force: true, maxZoom: 1 });
    }
  }, [paging, pile, camApiRef]);

  /**
   * agent 把某一页翻到用户眼前（edit_board{op:'show'} → ui.show_sheet →
   * 窗口事件）。它够不着的那一半在这儿：翻页 + 需要的话把镜头带过去。
   *
   * ⚠️ 镜头只在**跨摞**时带 —— 同一摞里翻页画面本来就在原地，动镜头是白抖一下。
   * 判据跟目录点击那条共用 pick，不另写一份。
   */
  useEffect(() => {
    const onShow = (e) => {
      const id = e?.detail?.sheet;
      if (!id) return;
      const target = paging.piles.find((p) => p.sheets.includes(id));
      if (target) pick(target, id);
    };
    window.addEventListener('nd:show-sheet', onShow);
    return () => window.removeEventListener('nd:show-sheet', onShow);
  }, [paging, pick]);

  /**
   * 板上一张叠起来的纸都没有就不出这一族（存量板、还没开工的板）——
   * FloatingToolbar 的组判据本来就在过滤空组，这里回 null 就行。
   */
  const hasStack = paging.piles.some((p) => p.sheets.length > 1);

  const group = useMemo(() => (hasStack && pile
    ? { id: 'stack', node: <StackPager pile={pile} index={index} onFlip={flip} onIndex={() => setIndexOpen((v) => !v)} /> }
    : null), [hasStack, pile, index, flip]);

  const panel = (hasStack && indexOpen)
    ? (
      <BoardIndex
        piles={paging.piles}
        sheets={sheets}
        shownOf={paging.shownOf}
        currentPile={pile?.name || null}
        onPick={pick}
        onClose={() => setIndexOpen(false)}
      />
    )
    : null;

  return { group, panel, pile, index, flip, pick, hasStack };
}

/**
 * 画布导航的总口（2026-09-01）：翻页器 / 翻件器**二选一**，加目录面板。
 *
 * 两套导航的手段根本不同 —— 翻页换的是画哪一张（相机不动），翻件是飞过去看下一件。
 * 板上有叠起来的摞就走前者，没有（存量板、还没开工的板）就走后者。收在这一个口
 * 是为了让 BoardCanvas 那边只有一行：谁该出场是导航自己的事，不是画布的事。
 */
export function useBoardNav({ paging, camera, cam, camApiRef, sheets, visibleObjects, layout }) {
  const reading = useReadingNav({ camApiRef, camera, cam, visibleObjects, layout, sheets });
  const stack = useStackNav({ paging, camera, cam, camApiRef, sheets });
  return {
    ...reading,
    navGroup: stack.group || reading.readGroup,
    panel: stack.panel,
    stack,
  };
}
