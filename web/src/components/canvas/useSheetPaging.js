/**
 * useSheetPaging —— 一摞纸翻到第几页（2026-09-01 叠纸刀 4）
 *
 * 显示到第几页**是看的人自己的事，不进 board.json**：两个人同时看一块板，一个
 * 在读第一拍、一个在读第三拍，都对。所以这里是 React state，不落盘、不上报。
 *
 * 缺省跟着最新那一页走（agent 叠一张新的，屏幕就翻过去），用户自己翻过之后认他
 * 选的那张 —— 相机「用户一接管就让位」的同一条规矩，换到翻页这一轴上。
 *
 * ⚠️ 藏起来的只有**认领了纸的墨**。没认领的（用户拖进来的散件、文件夹卡、产物）
 * 一页都不藏，它们不参与叠放。判据跟服务端算占位那份是同一条（claimedBy），
 * 两边一致才不会出现"屏幕上没有、可服务端说那儿占着地方"。
 */
import { useState, useMemo, useCallback } from 'react';
import { pilesOf, displayedPage, hiddenByPaging, flipTo, neighborPile } from '../../lib/board-paging.js';

/**
 * 墨 = 会参与叠放的那一类：板书（file-backed 的 markdown）、手写字、涂鸦。
 * 产物 / 站点 / 文档 / 文件夹卡不是 —— 见 claimFor 里的理由。
 */
function isInk(o) {
  return !!o?.chalk || (!!o?.native && (o.type === 'text' || o.type === 'scribble'));
}

export function useSheetPaging({ sheets, stacks, positionedRef, sizeOf }) {
  /** 用户显式翻过的：摞名 → 纸名。没翻过的摞不在这张表里 */
  const [picked, setPicked] = useState({});

  const piles = useMemo(() => pilesOf(sheets, stacks), [sheets, stacks]);
  const hiddenSheets = useMemo(() => hiddenByPaging(sheets, stacks, picked), [sheets, stacks, picked]);

  /** 这件东西此刻该不该藏（认领的那一页没在显示） */
  const isHidden = useCallback(
    (obj) => !!obj?.sheet && hiddenSheets.has(obj.sheet),
    [hiddenSheets],
  );

  /** 上下翻这一摞：+1 更新的、-1 更早的。到头不动 */
  const flip = useCallback((pileName, dir) => {
    setPicked((prev) => {
      const pile = piles.find((p) => p.name === pileName);
      if (!pile) return prev;
      const next = flipTo(pile, prev, dir);
      return next === displayedPage(pile, prev) ? prev : { ...prev, [pileName]: next };
    });
  }, [piles]);

  /** 直接翻到点名的那一页（agent 的 show / 目录点击都走这条） */
  const showSheet = useCallback((sheetId) => {
    const pile = piles.find((p) => p.sheets.includes(sheetId));
    if (!pile) return false;
    setPicked((prev) => ({ ...prev, [pile.name]: sheetId }));
    return true;
  }, [piles]);

  /** 这一摞现在显示哪一页 */
  const shownOf = useCallback((pileName) => {
    const pile = piles.find((p) => p.name === pileName);
    return pile ? displayedPage(pile, picked) : null;
  }, [piles, picked]);

  /** 左右换摞（到头 null）—— 换摞不改任何一摞翻到第几页，只是告诉调用方去哪 */
  const neighbor = useCallback((pileName, dir) => neighborPile(piles, pileName, dir), [piles]);

  /**
   * 用户拖完这张卡，它该认领哪一页。卡心落在哪一摞里，就归那一摞**此刻显示的
   * 那一页**；一摞都没落进返回 '' （空串 = 摘掉归属，合并语义下唯一表达得了
   * 「删掉这个键」的写法）。卡不在场返回 undefined = 这一发别动归属。
   *
   * 为什么是「此刻显示的那一页」而不是几何：叠起来的纸共用一块地，几何对一摞里
   * 每一页的答案完全一样。用户看着第三页把卡放上去，他放的就是第三页。
   */
  const claimFor = useCallback((id) => {
    const o = positionedRef?.current?.find((it) => it.id === id);
    if (!o) return undefined;
    // ⛔ **只有墨认领页**（站主拍板：这一版栈只叠板书）。产物 / 站点卡 / 文件夹卡
    // 不参与叠放，翻到哪一页都看得见 —— 给它们认领一页就等于把它们藏进某一页，
    // 那正是「产物不应该被覆盖」要防的事。它们的位置照旧只有几何。
    if (!isInk(o)) return undefined;
    const sz = sizeOf(o);
    const c = { x: o.pos.x + sz.w / 2, y: o.pos.y + sz.h / 2 };
    const pile = piles.find((p) => c.x >= p.x && c.x < p.x + p.w && c.y >= p.y && c.y < p.y + p.h);
    return pile ? (shownOf(pile.name) || '') : '';
  }, [piles, shownOf, positionedRef, sizeOf]);

  return { piles, picked, isHidden, hiddenSheets, flip, showSheet, shownOf, neighbor, claimFor };
}
