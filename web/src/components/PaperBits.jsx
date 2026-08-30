/**
 * 纸上的手绘零件 —— 登录墙和首页共用。
 *
 * 都是 SVG 手绘而不是字体符号：印刷体的圆圈和下划线太齐整，跟这套「随手写的」
 * 语气冲突。路径本身带抖动，缩放到任何尺寸都还是手画的。
 */
import { COLOR } from '../lib/theme.js';

/** 手写红圈：编号用（登录墙的 ①~⑥） */
export function Ring() {
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true">
      <path
        d="M15.5 2.6 C 23.4 2.2, 28.4 8.2, 27.4 15.4 C 26.5 22.6, 20.6 27.8, 13.6 27.3
           C 6.4 26.8, 2.1 21.2, 2.7 14.2 C 3.3 7.4, 8.2 3.2, 15.5 2.6
           C 17.2 2.5, 19.1 2.9, 20.6 3.6"
        fill="none" stroke={COLOR.error} strokeWidth="1.5" strokeLinecap="round" opacity="0.85"
      />
    </svg>
  );
}

/** 长尾夹：夹在纸的上边缘，cx 决定夹在哪一横向位置 */
export function Clip({ cx, className = 'clip' }) {
  return (
    <svg className={className} style={{ '--cx': cx }} viewBox="0 0 40 66" aria-hidden="true">
      <path d="M13 46 V15 a7.5 7.5 0 0 1 15 0 v33 a11.5 11.5 0 0 1-23 0 V19"
        fill="none" stroke="#8f8676" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

/** 手绘下划线：压在标题下面，w 是笔画粗细 */
export function Underline({ w = 2, color = COLOR.text, opacity = 0.8 }) {
  return (
    <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
      {/* ⚠️ stroke 走 style 不走属性：调用方可能传 var(--desk-ink)（台面上的那些
          标题夜里要翻成粉笔），而 var() 在 SVG 呈现属性上不保证解析。 */}
      <path d="M3 4 Q 30 2, 55 4.5 T 97 3.5" fill="none" style={{ stroke: color }}
        strokeWidth={w} strokeLinecap="round" opacity={opacity} />
    </svg>
  );
}
