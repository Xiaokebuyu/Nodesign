import { useState, useCallback } from 'react';
import { useMedia, COARSE } from './use-media.js';

/**
 * 「鼠标悬上去才露出来的那颗钮」在触屏上一律常驻（2026-08-31）。
 *
 * ## 它修的是什么
 *
 * 用户报「手机上项目卡要点两次才打开」。不是有意的，是 iOS 上一条很难自己想到的规则：
 *
 *   手指点一下 → Safari 先补一串合成鼠标事件（mouseover / mouseenter）
 *   → React 把 hover 置 true → **那颗钮当场插进 DOM**
 *   → ⛔ Safari 看到「这一下让内容变了」，于是**不再派发 click**
 *   → 第二下：hover 已经是 true，内容不变，click 才发出去
 *
 * 所以症状是「第一下什么都没发生，第二下才进去」。⭐ 病根不在 Link 上，
 * 在**那颗跟它同一个容器、靠 hover 才出现的钮**身上 —— 一个看着完全无关的元素。
 *
 * ## 为什么是一族，不是一处
 *
 * 「hover 才露出来」这个写法在仓里被抄了五处（项目卡的 ⋯、最近对话行的删除、
 * 橱窗卡的移出、会话列表的操作、文件行的删除）。⛔ 只修项目卡等于留四个复发点。
 * 判据在 use-hover-reveal.test.jsx 的「全仓不许再手抄这个写法」那一节：凡是 `{xxx && <button` 这种露出式的钮，
 * 都得走这个 hook。
 *
 * ## 触屏上「常驻」而不是「不给」
 *
 * 触屏没有 hover，所以那颗钮本来就没有能露出来的时机 —— 在这次修之前，
 * 手机上想点 ⋯ 只能靠「先误点一下卡、发现它冒出来了」。常驻既解决了双击，
 * 也把那个功能真正接通。五处露出的都是删除 / 移出 / 菜单，且破坏性的那几个
 * 背后都有二次确认，常驻不会一碰就没。
 *
 * @param {{onLeave?: () => void}} [opts] 鼠标移开时额外要做的事（比如顺手关掉菜单）
 * @returns {{revealed: boolean, hover: boolean, coarse: boolean, hoverProps: object}}
 *   revealed  该不该画那颗钮（触屏恒 true）
 *   hover     ⭐**真的有鼠标悬着**（触屏恒 false）。视觉上的抬起 / 变色要用这个，
 *             用 revealed 的话触屏上每张卡都永远浮着
 *   hoverProps 摊到容器上的 onMouseEnter/onMouseLeave；⭐**触屏上是空对象** ——
 *              不挂才是重点，挂了就还会触发上面那条 Safari 规则
 */
export function useHoverReveal({ onLeave } = {}) {
  const coarse = useMedia(COARSE);
  const [hover, setHover] = useState(false);
  const enter = useCallback(() => setHover(true), []);
  const leave = useCallback(() => { setHover(false); onLeave?.(); }, [onLeave]);
  return {
    revealed: coarse || hover,
    hover: hover && !coarse,
    coarse,
    hoverProps: coarse ? {} : { onMouseEnter: enter, onMouseLeave: leave },
  };
}
