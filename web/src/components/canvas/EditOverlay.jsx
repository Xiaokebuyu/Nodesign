import { useEffect, useState } from 'react';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { COLOR } from '../../lib/theme.js';

/**
 * EditOverlay — 选中元素的高亮边框
 *
 * 跟随策略（修 anchor.bbox 漂移 bug）：
 *   - 不使用 anchor.bbox（那是冻结的初次选中坐标）
 *   - 每次渲染用 element.getBoundingClientRect() 实时取位置
 *   - 监听 iframe 内 scroll + window resize → setTick 触发 re-render
 *   - 元素滚出 iframe 视口时 hide
 *
 * 由 Project.jsx 把 selectedAnchor / iframe ref 传过来。
 * Overlay 用 absolute positioning，定位相对 iframe.offsetParent (即 iframeWrapRef)。
 */
export default function EditOverlay({ selectedAnchor, iframeRef }) {
  const [, setTick] = useState(0);

  // 监听 iframe scroll / resize → 重计算 overlay 位置
  useEffect(() => {
    if (!selectedAnchor) return;
    const iframe = iframeRef?.current;
    if (!iframe) return;
    const win = iframe.contentWindow;
    if (!win) return;

    let rafId = null;
    const trigger = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setTick(t => t + 1);
      });
    };

    try {
      win.addEventListener('scroll', trigger, { passive: true, capture: true });
      win.addEventListener('resize', trigger);
      window.addEventListener('resize', trigger);
    } catch { /* cross-origin: skip */ }

    return () => {
      try {
        win.removeEventListener('scroll', trigger, { capture: true });
        win.removeEventListener('resize', trigger);
        window.removeEventListener('resize', trigger);
      } catch { /* */ }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [selectedAnchor, iframeRef]);

  if (!selectedAnchor || !iframeRef?.current) return null;

  const iframe = iframeRef.current;
  const doc = iframe.contentDocument;
  if (!doc) return null;

  // 实时找元素（anchor 三层 fallback：dataId / path / textHint）
  const el = findElementByAnchor(selectedAnchor, doc.body);
  if (!el) return null;

  // 实时计算位置：element 在 iframe viewport 中的位置 + iframe 在外层 viewport 中的位置
  const elRect = el.getBoundingClientRect();
  const iframeRect = iframe.getBoundingClientRect();

  // 元素滚出 iframe 视口 → hide overlay（避免 overlay 漂在 deck 之外）
  if (
    elRect.bottom <= 0 ||
    elRect.top >= iframeRect.height ||
    elRect.right <= 0 ||
    elRect.left >= iframeRect.width
  ) {
    return null;
  }

  // overlay 是 iframe.offsetParent (iframeWrapRef) 的 absolute child
  const offsetParent = iframe.offsetParent;
  if (!offsetParent) return null;
  const containerRect = offsetParent.getBoundingClientRect();

  // 转到 offsetParent 坐标系
  const top = (iframeRect.top + elRect.top) - containerRect.top;
  const left = (iframeRect.left + elRect.left) - containerRect.left;

  return (
    <div
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: top - 4,
        left: left - 4,
        width: elRect.width + 8,
        height: elRect.height + 8,
        border: `2px solid ${COLOR.btn}`,
        borderRadius: 4,
        boxShadow: '0 0 0 4px rgba(45, 36, 24, 0.08)',
        zIndex: 10,
        // 不加 transition —— 滚动跟随要瞬时，否则会拖尾
      }}
    />
  );
}
