import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { X, MapPin, MessageCircle, Trash2, Check } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { getElementRole, describePage, serializeForAI } from '../../lib/element-semantics.js';
import InspectTab from '../context-panel/InspectTab.jsx';

/**
 * InspectFloatingCard — 选中元素的 contextual 浮卡
 *
 * C3：替代原 InspectTab + Comments 浮窗双开模式 ——
 *   - 选中元素 = 自动弹（贴元素右上角，溢出钳到 iframe 边缘）
 *   - ESC / 切元素 / 点空白 = 自动收（在 CanvasFrame 顶层挂 ESC handler）
 *   - 内嵌 Comments 区（filter 该 anchor 的评论）+ inline textarea（Enter 提交）
 *   - 下半部分复用 InspectTab compact 模式（去 padding + 去重复 header + 去重复"写评论"按钮）
 *
 * 位置算法（参考 EditOverlay 的 zoom 适配）：
 *   - 实时 findElementByAnchor + el.getBoundingClientRect() 取 iframe 内坐标
 *   - 视觉坐标 = elRect.{x,y,w,h} * zoom（外层 iframe 已 transform: scale(zoom)）
 *   - 浮卡贴元素右上角，钳到 iframeRect 内
 *   - iframe scroll → 重新算位置（节流 rAF）
 *
 * 元素移出视口时：浮卡贴 iframe 边缘 + 加"跳到该元素" pin 按钮（scrollIntoView）
 */

const CARD_WIDTH = 340;
const CARD_OFFSET = 8;
const CARD_MAX_HEIGHT = 520;

export default function InspectFloatingCard({
  selectedAnchor,
  iframeDoc,
  iframeRef,
  iframeRect,
  zoom = 1,
  comments = [],
  onClose,
  onAddComment,
  onResolveComment,
  onDeleteComment,
  onDirectEdit,
  onTriggerRun,
}) {
  const cardRef = useRef(null);
  const [, setTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [cardHeight, setCardHeight] = useState(0);

  // 监听 iframe 滚动 / resize → 强制重算位置
  useEffect(() => {
    if (!selectedAnchor || !iframeRef?.current) return;
    const iframe = iframeRef.current;
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

  // 测量卡片高度（钳位用）
  useEffect(() => {
    if (!cardRef.current) return;
    const ro = new ResizeObserver(() => {
      const h = cardRef.current?.offsetHeight || 0;
      setCardHeight(prev => prev !== h ? h : prev);
    });
    ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, [selectedAnchor]);

  const el = useMemo(
    () => (selectedAnchor && iframeDoc ? findElementByAnchor(selectedAnchor, iframeDoc.body) : null),
    [selectedAnchor, iframeDoc],
  );

  // 该 anchor 的评论（按 dataId 优先 / path 兜底）
  const filteredComments = useMemo(() => {
    if (!selectedAnchor) return [];
    return comments.filter(c => {
      if (selectedAnchor.dataId && c.anchor?.dataId) return c.anchor.dataId === selectedAnchor.dataId;
      return c.anchor?.path === selectedAnchor.path;
    });
  }, [comments, selectedAnchor]);

  const handleSubmit = useCallback(() => {
    const text = draft.trim();
    if (!text || !el) return;
    const aiContext = serializeForAI(el);
    onAddComment?.({
      anchor: selectedAnchor,
      scope: 'this',
      aiContext,
      text,
    });
    setDraft('');
  }, [draft, el, selectedAnchor, onAddComment]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const scrollIntoView = useCallback(() => {
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* */ }
  }, [el]);

  if (!selectedAnchor || !el || !iframeRect || iframeRect.width === 0) return null;

  // 计算位置（基于 iframe 内 elRect，转外层视觉，钳到 iframeRect 内）
  const elRect = el.getBoundingClientRect();
  const innerW = iframeRef?.current?.contentWindow?.innerWidth ?? (iframeRect.width / zoom);
  const innerH = iframeRef?.current?.contentWindow?.innerHeight ?? (iframeRect.height / zoom);

  const offScreen =
    elRect.bottom <= 0 || elRect.top >= innerH || elRect.right <= 0 || elRect.left >= innerW;

  // 元素视觉 bbox（在外层 iframe 容器坐标系）
  const visLeft = elRect.left * zoom;
  const visTop = elRect.top * zoom;
  const visWidth = elRect.width * zoom;

  // 默认贴元素右上角；溢出右边 → 改贴左边；溢出下面 → 上移
  let cardLeft = visLeft + visWidth + CARD_OFFSET;
  if (cardLeft + CARD_WIDTH > iframeRect.width - CARD_OFFSET) {
    cardLeft = visLeft - CARD_WIDTH - CARD_OFFSET;
  }
  if (cardLeft < CARD_OFFSET) cardLeft = CARD_OFFSET;
  let cardTop = visTop;
  const effHeight = cardHeight || CARD_MAX_HEIGHT;
  if (cardTop + effHeight > iframeRect.height - CARD_OFFSET) {
    cardTop = Math.max(CARD_OFFSET, iframeRect.height - CARD_OFFSET - effHeight);
  }
  if (cardTop < CARD_OFFSET) cardTop = CARD_OFFSET;

  const role = getElementRole(el);
  const page = describePage(el);
  const tag = el.tagName.toLowerCase();

  return (
    <div
      ref={cardRef}
      style={{
        position: 'absolute',
        left: cardLeft, top: cardTop,
        width: CARD_WIDTH,
        maxHeight: CARD_MAX_HEIGHT,
        background: '#fff',
        border: `1px solid ${COLOR.borderMd}`,
        borderRadius: 10,
        boxShadow:
          '0 2px 4px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
        zIndex: 50,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        flexShrink: 0,
        background: 'rgba(255,255,255,0.95)',
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
          background: 'rgba(0,0,0,0.05)',
          padding: '1px 6px',
          borderRadius: 3,
        }}>&lt;{tag}&gt;</span>
        <span style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
          flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {page?.index !== undefined && page.index !== null && `第 ${page.index + 1} 页 · `}{role}
        </span>
        {offScreen && (
          <button
            onClick={scrollIntoView}
            title="滚动到该元素"
            style={{
              padding: 4, color: COLOR.text4, borderRadius: 3,
              background: 'rgba(0,0,0,0.04)',
            }}
          >
            <MapPin size={11} />
          </button>
        )}
        <button
          onClick={onClose}
          title="关闭（ESC）"
          style={{
            padding: 4, color: COLOR.text5, borderRadius: 3,
          }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

        {/* Comments — 顶部嵌入 */}
        <div style={{
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
          background: 'rgba(0,0,0,0.015)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: GAP.xs,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            marginBottom: GAP.sm,
          }}>
            <MessageCircle size={10} />
            评论 {filteredComments.length > 0 && `(${filteredComments.length})`}
          </div>

          {filteredComments.length > 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: GAP.xs,
              marginBottom: GAP.sm,
            }}>
              {filteredComments.map(c => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  onResolve={() => onResolveComment?.(c.id)}
                  onDelete={() => onDeleteComment?.(c.id)}
                />
              ))}
            </div>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder="评论这个元素，让 AI 看看…（Enter 提交，Shift+Enter 换行）"
            rows={2}
            style={{
              width: '100%',
              padding: `${GAP.sm}px ${GAP.md}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
              color: COLOR.text2,
              background: '#fff',
              border: `1px solid ${COLOR.borderLt}`,
              borderRadius: 4,
              resize: 'vertical',
              boxSizing: 'border-box',
              outline: 'none',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = COLOR.btn; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = COLOR.borderLt; }}
          />
        </div>

        {/* 元素详情 — 复用 InspectTab compact 模式 */}
        <InspectTab
          compact
          selectedAnchor={selectedAnchor}
          iframeDoc={iframeDoc}
          onDirectEdit={onDirectEdit}
          onTriggerRun={onTriggerRun}
        />
      </div>
    </div>
  );
}

function CommentRow({ comment, onResolve, onDelete }) {
  const resolved = comment.status === 'resolved';
  return (
    <div style={{
      padding: `${GAP.xs}px ${GAP.sm}px`,
      background: '#fff',
      border: `1px solid ${COLOR.borderLt}`,
      borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 4,
      opacity: resolved ? 0.5 : 1,
    }}>
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
        color: COLOR.text2,
        lineHeight: 1.5,
        textDecoration: resolved ? 'line-through' : 'none',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {comment.text}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4,
      }}>
        <button
          onClick={onResolve}
          title={resolved ? '取消解决' : '标记解决'}
          style={{ padding: 2, color: COLOR.sub, borderRadius: 3 }}
        >
          <Check size={10} />
        </button>
        <button
          onClick={onDelete}
          title="删除"
          style={{ padding: 2, color: COLOR.sub, borderRadius: 3 }}
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}
