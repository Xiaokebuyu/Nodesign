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
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { pilesOf, displayedPage, hiddenByPaging, flipTo, neighborPile } from '../../lib/board-paging.js';
import { SHELF_W, SHELF_H } from '../../lib/board-shelf.js';

/**
 * 墨 = 会参与叠放的那一类：板书（file-backed 的 markdown）、手写字、涂鸦。
 * 产物 / 站点 / 文档 / 文件夹卡不是 —— 见 claimFor 里的理由。
 */
function isInk(o) {
  return !!o?.chalk || (!!o?.native && (o.type === 'text' || o.type === 'scribble'));
}

/** 暂存架那一摞的摞名。它跟纸的摞并排住在同一张 picked 表里，翻法也一样 */
export const SHELF_PILE = '__shelf__';

/**
 * 一次翻页滑多久。跟 BoardObject 的 `left/top 380ms` 过渡对齐 —— 这个数只管
 * 「什么时候把旧页从 DOM 里摘掉」，滑动本身是 CSS 的事。留 40ms 余量，
 * 摘早了会看到旧页在半路上凭空消失。
 */
const FLIP_MS = 420;

export function useSheetPaging({ sheets, stacks, positionedRef, sizeOf, layout, shelf }) {
  /** 用户显式翻过的：摞名 → 那一摞里的第几件。没翻过的摞不在这张表里 */
  const [picked, setPicked] = useState({});

  /**
   * 翻页过渡（2026-09-01）：旧页往一边滑出去、新页从另一边滑进来，像手机主屏那样。
   *
   * ⭐ **动画不能靠相机**：叠起来的两页占同一块世界坐标，相机怎么动都没法把它们
   * 错开。所以是给两页的物件各加一个临时的横向位移 —— 卡片本来就有
   * `left/top 380ms` 的过渡（BoardObject 的 animateLayout），所以只要**先把新页
   * 摆在一屏之外渲染一帧，下一帧再摆回原位**，滑动就是 CSS 自己做的，一帧都不用
   * 我们逐帧算。用 rAF 逐帧推进的话整块画布要重渲十几次，那正是「板一多就卡」的来路。
   *
   * `phase`：'enter' = 新页还在屏外那一帧；'run' = 已摆回原位，CSS 正在滑。
   */
  const [flipping, setFlipping] = useState(null);
  const flipTimersRef = useRef([]);
  const beginFlip = useCallback((pile, from, to, dir) => {
    for (const t of flipTimersRef.current) clearTimeout(t);
    flipTimersRef.current = [];
    setFlipping({ pile: pile.name, from, to, dir, w: pile.w, phase: 'enter' });
    flipTimersRef.current.push(setTimeout(() => setFlipping((f) => (f ? { ...f, phase: 'run' } : f)), 16));
    flipTimersRef.current.push(setTimeout(() => setFlipping(null), FLIP_MS));
  }, []);
  useEffect(() => () => { for (const t of flipTimersRef.current) clearTimeout(t); }, []);

  /**
   * 暂存架也是一摞（2026-09-01，站主拍板「暂存架我们干脆也就改成栈吧」）。
   *
   * 架上的货全部叠在架位上（服务端 nextShelfSpot 现在恒返回原点），一次显示最
   * 上面那件，上下翻找 —— 跟纸用同一套导航。区别只有一个：这一摞的"页"是**物件**
   * 不是纸，所以顺序取 layout 的键序（= board.objects 的插入序 = 到货序，
   * 最后到的在最上面）。
   */
  const shelfIds = useMemo(
    () => Object.entries(layout || {}).filter(([, e]) => e?.seat === 'shelf').map(([id]) => id),
    [layout],
  );

  const piles = useMemo(() => {
    const list = pilesOf(sheets, stacks);
    if (!shelfIds.length || !Number.isFinite(shelf?.x)) return list;
    // 架位的脚印跟服务端 SHELF_W/SHELF_H 对齐（board-shelf.js，parity 测试钉着）
    list.push({
      name: SHELF_PILE, shelf: true, x: shelf.x, y: shelf.y, w: SHELF_W, h: SHELF_H,
      title: '暂存', at: '', sheets: shelfIds, implicit: true,
    });
    return list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }, [sheets, stacks, shelfIds, shelf]);
  const hiddenSheets = useMemo(() => hiddenByPaging(sheets, stacks, picked), [sheets, stacks, picked]);

  /**
   * 这件东西此刻该不该藏（认领的那一页没在显示）。
   * ⚠️ 过渡期间**旧页不藏** —— 它得留在屏幕上滑出去，藏了就是硬切。
   */
  const isHidden = useCallback(
    (obj) => !!obj?.sheet && hiddenSheets.has(obj.sheet) && obj.sheet !== flipping?.from,
    [hiddenSheets, flipping],
  );

  /**
   * 这件东西此刻要往旁边挪多少（过渡期间才非零）。
   * 新页 'enter' 那一帧摆在来的方向一屏之外，'run' 摆回 0（CSS 负责这段滑动）；
   * 旧页反过来，从 0 滑到去的方向一屏之外。
   */
  const shiftOf = useCallback((obj) => {
    const f = flipping;
    if (!f || !obj?.sheet) return 0;
    const span = f.w + 48;
    if (obj.sheet === f.to) return f.phase === 'enter' ? f.dir * span : 0;
    if (obj.sheet === f.from) return f.phase === 'enter' ? 0 : -f.dir * span;
    return 0;
  }, [flipping]);

  /** 架上这一件该不该藏（一摞只画最上面那件）。架上只有一件时谁都不藏 */
  const shelfShown = useMemo(() => {
    if (shelfIds.length < 2) return null;
    const want = picked[SHELF_PILE];
    return want && shelfIds.includes(want) ? want : shelfIds[shelfIds.length - 1];
  }, [shelfIds, picked]);
  const isShelfHidden = useCallback(
    (id) => !!shelfShown && id !== shelfShown && shelfIds.includes(id),
    [shelfShown, shelfIds],
  );


  /** 上下翻这一摞：+1 更新的、-1 更早的。到头不动 */
  const flip = useCallback((pileName, dir) => {
    setPicked((prev) => {
      const pile = piles.find((p) => p.name === pileName);
      if (!pile) return prev;
      // 架那一摞的"页"是物件 id，纸那一摞是纸名 —— flipTo 只认顺序，两种都能翻
      const next = flipTo(pile, prev, dir);
      const cur = displayedPage(pile, prev);
      if (next === cur) return prev;
      beginFlip(pile, cur, next, dir);
      return { ...prev, [pileName]: next };
    });
  }, [piles, beginFlip]);

  /** 直接翻到点名的那一页（agent 的 show / 目录点击都走这条） */
  const showSheet = useCallback((sheetId) => {
    const pile = piles.find((p) => p.sheets.includes(sheetId));
    if (!pile) return false;
    setPicked((prev) => {
      const cur = displayedPage(pile, prev);
      if (cur === sheetId) return prev;
      // 跳着翻也走同一段滑动：方向按两页在这一摞里的先后
      beginFlip(pile, cur, sheetId, pile.sheets.indexOf(sheetId) > pile.sheets.indexOf(cur) ? 1 : -1);
      return { ...prev, [pile.name]: sheetId };
    });
    return true;
  }, [piles, beginFlip]);

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

  return {
    piles, picked, isHidden, hiddenSheets, flip, showSheet, shownOf, neighbor, claimFor,
    isShelfHidden, shelfCount: shelfIds.length, shiftOf, flipping,
  };
}
