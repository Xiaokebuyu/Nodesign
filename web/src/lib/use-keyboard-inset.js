import { useEffect, useState } from 'react';

/**
 * 软键盘从底下盖上来了多少（2026-08-31 移动端第三轮 · 第六刀）
 *
 * ## 为什么需要这个数
 *
 * 两端现在都是「**键盘覆盖**」：Chrome 108 起安卓的默认就是 `resizes-visual`
 * （只缩视觉视口，不动布局视口），iOS Safari 一直如此。好处是页面不重排 ——
 * 画布不会因为弹个键盘就跳一下，`dvh` 也稳定。
 *
 * ⛔ 代价是**被键盘盖住的东西，页面自己完全不知道**。以前浏览器还会替我们滚一下
 * 把光标露出来，但 08-31 那一刀把 `body` 钉成了 `position: fixed`（治输入框焦点
 * 那条橡皮筋），**浏览器现在滚不动了**。两件事合起来 = 输入框可能被压在键盘底下
 * 且没人来救。所以覆盖模式必须自带这个数，谁在底下谁自己抬。
 *
 * ## 怎么算
 *
 *     盖住的高度 = 布局视口高 − 视觉视口高 − 视觉视口的上偏移
 *
 * ⭐ 布局视口高读 `documentElement.clientHeight`：body 是 fixed + overflow:hidden，
 * 这个数不会因为键盘变，所以差值就是键盘（加上底部工具条）。
 *
 * ⚠️ 阈值 80px：地址栏收展、四舍五入都会让两边差出几像素，不设阈值的话
 * 一路滚动就会被误判成「键盘弹出来了」。真键盘没有低于 150px 的。
 *
 * ⚠️ 用 rAF 合帧：`visualViewport` 的 resize 在键盘动画期间每帧都发，
 * 直接 setState 会把动画那 250ms 变成几十次渲染。
 *
 * @returns {{inset: number, visibleH: number}}
 *   inset    键盘盖住的高度（没键盘时是 0）
 *   visibleH 键盘之上还剩多少可见高度
 */
const MIN_KEYBOARD = 80;

export function useKeyboardInset() {
  const [state, setState] = useState(() => ({
    inset: 0,
    visibleH: typeof document === 'undefined' ? 0 : document.documentElement.clientHeight,
  }));

  useEffect(() => {
    const vv = window.visualViewport;
    // 老浏览器没有 visualViewport：那就当永远没键盘，各处退回原来的排法
    if (!vv) return undefined;
    let raf = 0;
    const read = () => {
      raf = 0;
      const layoutH = document.documentElement.clientHeight;
      const covered = Math.round(layoutH - vv.height - vv.offsetTop);
      const inset = covered >= MIN_KEYBOARD ? covered : 0;
      const visibleH = layoutH - inset;
      setState(prev => (prev.inset === inset && prev.visibleH === visibleH ? prev : { inset, visibleH }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
    };
  }, []);

  return state;
}

/**
 * 正在打字的那个框被键盘盖住了就把它滚出来 —— 兜底的那一层。
 *
 * 抽屉那种自己知道该抬多少的容器走 `useKeyboardInset` 自己抬；这条管的是
 * 剩下所有「随便哪个页面里的一个输入框」（首页那本便签、弹窗里的重命名框……）。
 *
 * ⛔ 不能用 `scrollIntoView({block:'nearest'})`：它判「看不看得见」用的是**布局视口**，
 * 而键盘盖住的那一截在布局视口里仍然算"可见"。所以得自己拿 inset 算一遍。
 *
 * ⚠️ 只往上滚不往下滚（`delta > 0` 才动）：框本来就在视野里的时候一个像素都别碰，
 * 否则每次弹键盘页面都会自己动一下。
 */
export function useKeepFocusAboveKeyboard(inset) {
  useEffect(() => {
    if (!inset) return undefined;
    // 等键盘动画停下来再量，不然量到的是动画中间某一帧
    const timer = setTimeout(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return;
      const editable = el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName);
      if (!editable) return;
      const limit = document.documentElement.clientHeight - inset - 12;
      const delta = el.getBoundingClientRect().bottom - limit;
      if (delta <= 0) return;
      // 找最近一个真能滚的祖先
      for (let p = el.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
          p.scrollTop += delta;
          return;
        }
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [inset]);
}
