/**
 * 在一件东西上点一下，意味着什么（2026-08-30 从 BoardCanvas 拆出）。
 *
 * 语义（2026-08-27 用户拍板）：**单击 = 选中它 + 直接开标注纸**。标注是画布上
 * 最常用的动作，所以它不藏在按钮后面；同日撤掉了点选之后弹的那条操作条。
 *
 * 命中不走 DOM 走几何：指针捕获下 DOM 命中会被重定向（08-25 板书武装案），
 * 所以拿世界坐标对矩形算。叠成一摞的产物再点同一处会**循环翻到底下那件**
 * （nextPick），翻到谁标注就落到谁 —— 挤堆场景靠这个解。
 *
 * ## ⭐⭐ 为什么要压一个双击窗口
 *
 * 上面这套挂在 pointerup 的「按下没拖动 = 单击」上，而**双击必然包含两次按下
 * 没拖动**。于是双击开一件站点／幻灯（08-30 生产实拍）：
 *
 *     第一下  → 弹出标注纸
 *     第二下  → 再弹一次，且 nextPick 把选中翻到叠在下面那件
 *     dblclick → 窗铺开，而那张纸**没人收**
 *                （在这之前全仓 setAnnotate(null) 只有浮层自己的 onClose）
 *
 * 结果是标注纸搁浅在开好的站点正中间，下半截被站点自己的工具栏压住。
 *
 * 修法不是"开窗时把纸关掉"（那样第一下还是会闪一张纸出来），是**整个 clickSelect
 * 延后**：dblclick 紧跟在第二下之后，正好赶在定时器之前把它掐掉，于是双击全程
 * 一张纸都不弹，叠堆下翻也不会在两下之间跳。选中环跟着一起晚一点 ——
 * 用户 2026-08-30 拍板接受（"标注慢点显示没什么问题"）。
 *
 * ⚠️ 220ms 是**人双击的间隔**（通常 120-250ms），不是浏览器 dblclick 的上限（500ms）。
 *    调大它，单击叫标注会真的变卡；调到 150 以下，慢一点的双击会漏出一张纸。
 */
import { useEffect, useRef } from 'react';
import { hitsAt, nextPick } from '../../lib/board-geometry.js';
import { sizeOf, annotTargetOf } from '../../lib/board-kinds.js';

export const DBL_WINDOW_MS = 220;

/**
 * @param {object}   o
 * @param {object}   o.camera            toWorld 用
 * @param {object}   o.positionedRef     当前桌面上所有件（ref，命中要用最新的）
 * @param {object}   o.selectedIdsRef    当前选中（ref，叠堆下翻要知道上一次翻到谁）
 * @param {Function} o.setSelectedIds
 * @param {Function} o.setAnnotate
 * @param {object}   o.roleNames         annotTargetOf 用（演出模式的角色名表）
 * @param {boolean}  o.windowOpen        产物窗开着没（幻灯/站点/docx/浏览器四种）
 * @returns {{ clickSelect: Function, cancelPendingClick: Function }}
 */
export function useObjectClick({
  camera, positionedRef, selectedIdsRef, setSelectedIds, setAnnotate, roleNames, windowOpen,
}) {
  const timerRef = useRef(null);

  const cancelPendingClick = () => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const apply = (domId, cx, cy) => {
    const pt = camera.toWorld(cx, cy);
    const hits = hitsAt(positionedRef.current, sizeOf, pt);
    const cur = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0] : null;
    const pick = nextPick(hits.length ? hits : (domId ? [domId] : []), cur);
    if (!pick && !selectedIdsRef.current.length) return;   // 空地点空地，别空转渲染
    setSelectedIds(pick ? [pick] : []);
    const o = pick ? positionedRef.current.find(it => it.id === pick) : null;
    // 标注纸自己管退场（点外面/Esc 即关），点下一件时上一张已被 pointerdown 收掉
    if (o) setAnnotate({ x: cx, y: cy + 12, target: annotTargetOf(o, roleNames) });
  };

  const clickSelect = (domId, cx, cy) => {
    cancelPendingClick();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      apply(domId, cx, cy);
    }, DBL_WINDOW_MS);
  };

  /**
   * 开窗即收纸 —— 上面那道延迟已经挡住了"双击开窗"这条路，这条是**兜底**：
   * 标注纸的锚点是一对屏幕坐标，窗一铺开，那对坐标指的地方已经不是它标注的
   * 那件东西了。右键菜单打开、工具直接开窗这些路径也从这儿收。
   */
  useEffect(() => {
    if (!windowOpen) return;
    cancelPendingClick();
    setAnnotate(null);
    // setAnnotate 是 useState 的 setter，恒定；cancelPendingClick 只碰 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowOpen]);

  useEffect(() => cancelPendingClick, []);   // 卸载时别把定时器留在外面

  return { clickSelect, cancelPendingClick };
}
