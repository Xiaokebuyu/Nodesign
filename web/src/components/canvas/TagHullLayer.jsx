/**
 * TagHullLayer —— 同 #tag 的包络（2026-08-23 黑板）
 *
 * 黑板不设容器（用户拍板），「组」是 tag 派生的。这一层把同一个 tag 的成员圈一道极淡的
 * 圆角虚线包络 + 左上角一个 #tag 小标，让人一眼看出"这几件是一张图"。**纯派生、零数据**：
 * 删了成员它自己缩，一件都不剩就没了；不吃指针事件（pointerEvents none），点空地照样拖镜头。
 * 只画 ≥2 件的 tag；草稿态（全员 staging）再淡一档。
 */
import { useMemo } from 'react';
import { sizeOf } from '../../lib/board-kinds.js';
import { CANVAS, FONT_SANS, FONT_SIZE, alpha } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';

const PAD = 18;

export default function TagHullLayer({ positioned, onGrab }) {
  const hulls = useMemo(() => {
    const byTag = new Map();
    for (const o of positioned || []) {
      const tag = o.tag || o.pos?.tag;
      if (!tag || !o.pos) continue;
      const sz = sizeOf(o);
      const r = { x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h, staging: !!(o.staging || o.pos?.staging) };
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(r);
    }
    const out = [];
    for (const [tag, rs] of byTag) {
      if (rs.length < 2) continue;
      const x0 = Math.min(...rs.map(r => r.x)) - PAD; const y0 = Math.min(...rs.map(r => r.y)) - PAD;
      const x1 = Math.max(...rs.map(r => r.x + r.w)) + PAD; const y1 = Math.max(...rs.map(r => r.y + r.h)) + PAD;
      out.push({ tag, x: x0, y: y0, w: x1 - x0, h: y1 - y0, staging: rs.every(r => r.staging) });
    }
    return out;
  }, [positioned]);

  if (!hulls.length) return null;
  return (
    <>
      {hulls.map(h => (
        <div key={h.tag} aria-hidden style={{
          position: 'absolute', left: h.x, top: h.y, width: h.w, height: h.h,
          borderRadius: 16, pointerEvents: 'none',
          border: `1px dashed ${alpha(CANVAS.brass, h.staging ? 0.22 : 0.38)}`,
          background: alpha(CANVAS.brass, h.staging ? 0.018 : 0.035),
          zIndex: 0,
        }} />
      ))}
      {hulls.map(h => (
        <span
          key={`chip:${h.tag}`}
          // 小标是整组的抓手（08-25 用户提「整 tag 一起移动」）：按住拖 = 选中
          // 整组并整体挪。⚠️ chip 必须单独渲染在卡片层之上 —— 塞在 zIndex 0 的
          // 包络 div 里会被上层吃指针的东西盖住，按不到（08-25 探针实锤）
          onPointerDown={onGrab ? (e) => { e.stopPropagation(); onGrab(h.tag, e); } : undefined}
          style={{
            position: 'absolute', left: h.x + 10, top: h.y - 9, padding: '0 6px',
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: alpha(PAPER.ink2, 0.75),
            background: PAPER.wall, borderRadius: 6, lineHeight: '16px', zIndex: 58,
            border: `1px dashed ${alpha(CANVAS.brass, 0.3)}`,
            ...(onGrab ? { pointerEvents: 'auto', cursor: 'grab', touchAction: 'none' } : { pointerEvents: 'none' }),
          }}>#{h.tag}</span>
      ))}
    </>
  );
}
