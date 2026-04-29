/**
 * EditOverlay — 选中元素的高亮边框 / 评论锚点
 *
 * P1 极简：只显示当前选中元素的位置（半透明边框）。锚点 marker 由 P2 加。
 *
 * 由 Project.jsx 把 selectedAnchor / iframe ref 传过来。
 * 这层是 absolute-positioned div，覆盖在 iframe 之上但 pointer-events: none，
 * 不阻挡 iframe 内的事件。
 */

import { COLOR } from '../../lib/theme.js';

export default function EditOverlay({ selectedAnchor, iframeRef }) {
  if (!selectedAnchor || !iframeRef?.current) return null;

  const iframe = iframeRef.current;
  const iframeRect = iframe.getBoundingClientRect();
  const containerRect = iframe.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;

  // 锚点 bbox 是 iframe 内部坐标，要换算到 overlay（跟 iframe 同 parent）的相对坐标
  const offsetTop  = iframeRect.top  - containerRect.top;
  const offsetLeft = iframeRect.left - containerRect.left;

  const { bbox } = selectedAnchor;
  if (!bbox) return null;

  return (
    <div
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        top:  offsetTop  + bbox.y - 4,
        left: offsetLeft + bbox.x - 4,
        width:  bbox.w + 8,
        height: bbox.h + 8,
        border: `2px solid ${COLOR.btn}`,
        borderRadius: 4,
        boxShadow: `0 0 0 4px rgba(45, 36, 24, 0.08)`,
        transition: 'all 0.15s cubic-bezier(0.25, 1, 0.5, 1)',
        zIndex: 10,
      }}
    />
  );
}
