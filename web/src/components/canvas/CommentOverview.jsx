import { useEffect, useRef, useMemo } from 'react';
import { MessageSquare, MapPin, Check, Trash2, X } from 'lucide-react';
import { useAnchoredPosition } from '../../lib/anchored-popover.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { describePage } from '../../lib/element-semantics.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * CommentOverview — 评论汇总浮窗（贴 toolbar Comment 按钮）
 *
 * 2026-05-07 新增：CanvasToolbar Comment 按钮点击后弹出，列出本 deck 所有评论。
 *
 * 内容：
 *   - 按页分组（第 1 页 / 第 2 页 / ... / 未定位 ）
 *   - 每条评论显示：评论文字 + 元素标签 + 状态（pending/resolved）
 *   - 点击 → scrollIntoView 该元素（用 findElementByAnchor 在 iframeDoc 找）
 *   - Resolve / Delete 按钮
 *
 * 形状：top:78 right:16，跟 SystemPopover 同款定位 + click-outside 关。
 */
export default function CommentOverview({
  comments = [],
  iframeDoc,
  iframeRef,
  anchorRef,
  onClose,
  onResolveComment,
  onDeleteComment,
  onSelectAnchor,
}) {
  const ref = useRef(null);
  const anchored = useAnchoredPosition(anchorRef, 380);

  // 点外面关
  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose, anchorRef]);

  // ESC 关
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 按页分组
  const grouped = useMemo(() => {
    const byPage = new Map();
    for (const c of comments) {
      const el = iframeDoc && c.anchor ? findElementByAnchor(c.anchor, iframeDoc.body) : null;
      const page = el ? describePage(el) : null;
      const key = page?.index ?? null; // null = 未定位（元素已删）
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key).push({ comment: c, el });
    }
    // 排序：null（未定位）放最后，其他按页号升序
    const entries = [...byPage.entries()].sort((a, b) => {
      if (a[0] === null) return 1;
      if (b[0] === null) return -1;
      return a[0] - b[0];
    });
    return entries;
  }, [comments, iframeDoc]);

  const handleClickComment = (item) => {
    if (item.el) {
      try { item.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* */ }
    }
    if (onSelectAnchor) {
      onSelectAnchor(item.comment.anchor);
    }
  };

  return (
    <div
      ref={ref}
      style={{
        ...anchored,
        width: 380,
        background: COLOR.bgWhite,
        borderRadius: 2,
        boxShadow:
          '0 2px 4px rgba(43,33,23,0.04), 0 8px 20px rgba(43,33,23,0.08), 0 24px 48px rgba(43,33,23,0.10), inset 0 1px 0 rgba(255,254,246,0.8)',
        zIndex: 60,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        flexShrink: 0,
      }}>
        <MessageSquare size={12} color={COLOR.text4} />
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
          flex: 1,
        }}>
          全部评论 {comments.length > 0 && `(${comments.length})`}
        </span>
        <button
          onClick={onClose}
          title="关闭"
          style={{
            padding: GAP.xs, color: COLOR.text5, borderRadius: RADIUS.xs,
            background: 'transparent', border: 'none', cursor: 'pointer',
          }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {comments.length === 0 ? (
          <div style={{
            padding: `${GAP.lg + GAP.md}px ${GAP.lg}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            textAlign: 'center',
            lineHeight: 1.6,
          }}>
            还没有评论。<br />
            点击画布上任意元素 → 在弹出的浮卡里写评论。
          </div>
        ) : (
          grouped.map(([pageIdx, items]) => (
            <div key={pageIdx ?? 'orphan'} style={{
              padding: `${GAP.md}px ${GAP.lg}px`,
              borderBottom: `1px solid ${COLOR.borderLt}`,
            }}>
              <div style={{
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
                color: COLOR.sub, textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: GAP.sm,
              }}>
                {pageIdx === null ? '未定位' : `第 ${pageIdx + 1} 页`}
                {' · '}{items.length} 条
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
                {items.map(({ comment: c, el }) => (
                  <CommentCard
                    key={c.id}
                    comment={c}
                    available={!!el}
                    onClick={() => handleClickComment({ comment: c, el })}
                    onResolve={() => onResolveComment?.(c.id)}
                    onDelete={() => onDeleteComment?.(c.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: COLOR.bgCard,
        borderTop: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5,
        flexShrink: 0,
      }}>
        点击评论 → 跳到对应元素；evaluator 切到 edit 模式后可在浮卡续写。
      </div>
    </div>
  );
}

function CommentCard({ comment, available, onClick, onResolve, onDelete }) {
  const resolved = comment.status === 'resolved';
  return (
    <div style={{
      padding: `${GAP.sm}px ${GAP.md}px`,
      background: COLOR.bgWhite,
      boxShadow: PAPER_SHADOW.far,
      borderRadius: RADIUS.md,
      display: 'flex', flexDirection: 'column', gap: GAP.xs,
      opacity: resolved ? 0.5 : 1,
      cursor: available ? 'pointer' : 'default',
      transition: 'background 0.1s',
    }}
    onClick={available ? onClick : undefined}
    onMouseEnter={(e) => {
      if (available) e.currentTarget.style.background = 'rgba(43,33,23,0.02)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = COLOR.bgWhite;
    }}
    >
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: COLOR.text2,
        lineHeight: 1.5,
        textDecoration: resolved ? 'line-through' : 'none',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {comment.text}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: GAP.xs,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
      }}>
        {available ? (
          <>
            <MapPin size={9} />
            <span>{comment.anchor?.dataId || comment.anchor?.path?.split('>').pop() || '元素'}</span>
          </>
        ) : (
          <span style={{ fontStyle: 'italic' }}>元素已不在</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={(e) => { e.stopPropagation(); onResolve(); }}
          title={resolved ? '取消解决' : '标记解决'}
          style={{ padding: GAP.xxs, color: COLOR.sub, borderRadius: RADIUS.xs, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Check size={11} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
          style={{ padding: GAP.xxs, color: COLOR.sub, borderRadius: RADIUS.xs, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
