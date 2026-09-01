/**
 * useSwipeNav —— 钉住视区时，手指横滑换摞、竖滑翻页（2026-09-01 叠纸刀 6）
 *
 * 站主要的是「像手机滑动切换屏幕那样」。两条轴各管一件事：
 *   横滑 → 相邻的那一摞
 *   竖滑 → 这一摞里的上一页 / 下一页
 *
 * ## 闸有两道，都是状态不是阈值
 *
 * ① **钉住**（用户/agent 拨的开关）—— 没钉住时手指照旧推画面，一个字不改。
 * ② **这一轴上没有可平移的量**（`navAxes`）—— 整摞在这一轴上已经全进视口了，
 *    横推推不出新东西来，那横滑只剩"换摞"一种讲得通的意思。放大到读细节时两轴
 *    都有余量，手势自动全部让回给平移。
 *
 * ⚠️ 一个手势两种含义是这套里最容易做错的地方（08-21 捏合把卡带跑、08-31 平板
 * 单指归工具，都是这一族）。所以判据只用当下的状态，不引入"滑多快算翻页"这类
 * 拍脑袋的数；唯一的数是**滑多远才算数**，那是防误触，不是语义。
 *
 * ## 为什么又是捕获阶段的原生监听
 *
 * 跟 useTouchGestures 同一个理由：画布的 pointerdown 是按优先级分派的（工具 →
 * 框选 → 相机），要在所有人之前判断这一下归不归导航，只能在捕获阶段看。判成导航
 * 之后 `stopPropagation` 把它从相机那条路上摘掉，画面就不会边翻页边平移。
 */
import { useEffect, useRef } from 'react';

/** 滑多远才算数（屏幕像素）。防误触用，不是语义 —— 比长按拖卡的 14px 大得多 */
const COMMIT = 56;
/** 两轴都动了多少才判方向：主轴要明显压过副轴，否则是斜着划，不认 */
const AXIS_RATIO = 1.6;

export function useSwipeNav({ paneRef, enabled, axesRef, onSwipe }) {
  const ref = useRef(null);
  if (!ref.current) ref.current = { id: null, x0: 0, y0: 0, fired: false, claimed: false };

  useEffect(() => {
    const el = paneRef?.current;
    if (!el || !enabled) return undefined;
    const S = ref.current;

    const onDown = (e) => {
      if (!e.isTrusted || e.pointerType !== 'touch') return;
      if (S.id !== null) { S.id = null; return; }   // 第二根手指落下 = 这是相机手势，不是滑动
      S.id = e.pointerId; S.x0 = e.clientX; S.y0 = e.clientY;
      S.fired = false; S.claimed = false;
    };

    const onMove = (e) => {
      if (S.id !== e.pointerId || S.fired) return;
      const dx = e.clientX - S.x0;
      const dy = e.clientY - S.y0;
      const ax = Math.abs(dx); const ay = Math.abs(dy);
      const axes = axesRef.current || { x: false, y: false };
      // 主轴要明显压过副轴，且那一轴此刻归导航
      const horiz = ax > ay * AXIS_RATIO && axes.x;
      const vert = ay > ax * AXIS_RATIO && axes.y;
      if (!horiz && !vert) return;
      // 认领这一下：从此它不再是平移（相机收不到了）
      S.claimed = true;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      if (Math.max(ax, ay) < COMMIT) return;
      S.fired = true;
      // 手指往左划 = 看右边那一摞（内容跟着手指走），竖向同理
      onSwipe(horiz ? 'x' : 'y', (horiz ? dx : dy) < 0 ? 1 : -1);
    };

    const onUp = (e) => {
      if (S.id !== e.pointerId) return;
      if (S.claimed) e.stopPropagation();
      S.id = null; S.fired = false; S.claimed = false;
    };

    const opts = { capture: true, passive: false };
    el.addEventListener('pointerdown', onDown, opts);
    el.addEventListener('pointermove', onMove, opts);
    el.addEventListener('pointerup', onUp, opts);
    el.addEventListener('pointercancel', onUp, opts);
    return () => {
      el.removeEventListener('pointerdown', onDown, opts);
      el.removeEventListener('pointermove', onMove, opts);
      el.removeEventListener('pointerup', onUp, opts);
      el.removeEventListener('pointercancel', onUp, opts);
      S.id = null;
    };
  }, [paneRef, enabled, axesRef, onSwipe]);
}
