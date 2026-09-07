// web/src/components/ui/Popover.jsx — 锚在某颗按钮旁边的浮层（下拉菜单 / 选择器）。
//
// 为什么要 portal（09-07 站主：「弹出窗口要不透明，半透明很影响阅读」）：
//   首页的光源层是一块压在**所有内容之上**的画布（home-sun.js 的 .ndd-canopy.over，z 950），
//   夜里它把整间屋子压暗 —— 台面、纸、顶栏都该暗，这是设计。但下拉菜单也在它底下，
//   于是夜里打开模型选择器 / 语言菜单，看到的是一张被压成深灰的纸，字几乎读不了；
//   看起来就像"半透明"。菜单跟纸不一样：它是**此刻要读的东西**，不该跟着屋子一起暗。
//   而菜单挂在内容树里（.ndd-in 是 z-index:1 的层叠上下文），z-index 写多大都爬不出去，
//   唯一的路是 portal 到光源层之外、之上。
//
// 定位：按锚的 getBoundingClientRect 用 fixed 落点，resize / 任何滚动都重算。
// 关外点击与 Escape 由这里统一管（portal 之后菜单不再是锚的后代，调用方原来那句
// `ref.contains(e.target)` 会把菜单内部的点击当成关外点击）。
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/** 压在首页光源层（950）、顶栏（900）、弹窗（960）、toast（1000）之上；留在 FloatingPanel 的 9998 之下 */
export const POPOVER_Z = 9600;

/**
 * @param {object} p
 * @param {boolean} p.open
 * @param {import('react').RefObject<HTMLElement>} p.anchorRef 锚（按钮）。点它不算关外
 * @param {() => void} [p.onClose] 关外点击 / Escape
 * @param {'down'|'up'} [p.placement] 往下开还是往上开
 * @param {'left'|'right'} [p.align] 跟锚的哪条边对齐
 * @param {number} [p.offset] 与锚的间距
 * @param {HTMLElement|null} [p.container] 落到哪个节点下。缺省 body；首页那些吃 .ndd 作用域 CSS 变量的菜单传 .ndd
 * @param {object} [p.style] 追加在定位层上
 * @param {string} [p.role]
 */
export default function Popover({ open, anchorRef, onClose, placement = 'down', align = 'left', offset = 6, container = null, style, role, children }) {
  const [rect, setRect] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setRect(null); return undefined; }
    const update = () => {
      const r = anchorRef?.current?.getBoundingClientRect?.();
      if (r) setRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (anchorRef?.current?.contains?.(e.target)) return;
      if (e.target?.closest?.('[data-nd-popover]')) return;
      onClose?.();
    };
    const esc = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, anchorRef, onClose]);

  if (!open || !rect || typeof document === 'undefined') return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pos = {
    position: 'fixed', zIndex: POPOVER_Z,
    ...(placement === 'up' ? { bottom: Math.max(0, vh - rect.top + offset) } : { top: rect.bottom + offset }),
    ...(align === 'right' ? { right: Math.max(0, vw - rect.right) } : { left: Math.max(0, rect.left) }),
    // 别伸出屏幕：左对齐的菜单贴着右屏沿收窄，右对齐的贴着左屏沿
    maxWidth: Math.max(160, align === 'right' ? rect.right - 8 : vw - rect.left - 8),
    ...style,
  };
  return createPortal(<div data-nd-popover role={role} style={pos}>{children}</div>, container || document.body);
}
