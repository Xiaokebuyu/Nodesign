import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { X, MapPin, MessageCircle, Trash2, Check } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { isImeEnter } from '../../lib/helpers.js';
import { getElementRole, describePage, serializeForAI, redactAnchor } from '../../lib/element-semantics.js';
import { overlayBase, placeFloatingCard } from '../../lib/overlay-rect.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * InspectFloatingCard — 选中元素的 contextual 浮卡（2026-05-07 瘦身版）
 *
 * 改造：原来含 [Comments + InspectTab(DirectEdit / 元素详情)] 双区，
 * 这次只保留 Comments 区。DirectEdit / 元素属性编辑职责整体迁移到升级后的 Tweaks（下期，详见 memory idea_tweaks_v2_unified_panel.md）。
 *
 *   - 选中元素 = 自动弹（贴元素右上角，溢出钳到 iframe 边缘）
 *   - ESC / 切元素 / 点空白 = 自动收（在 CanvasFrame 顶层挂 ESC handler）
 *   - 评论列表 + inline textarea（Enter 提交）
 *
 * 定位走 lib/overlay-rect.js 的 overlayBase + placeFloatingCard，跟其余五个浮层
 * 同一份换算。（2026-07-31 前这里是自己一套只乘 zoom 不加位移的算法，就是那个
 * "评论卡飘到别处"。）
 */

const CARD_WIDTH = 340;
const CARD_OFFSET = 8;
const CARD_MAX_HEIGHT = 520;

export default function InspectFloatingCard({
  selectedAnchor,
  redactText = undefined,   // 演出页隐私：true=评论序列化剥文本（SiteWindow 按 hasOrch 传）
  iframeDoc,
  iframeRef,
  iframeRect,
  zoom = 1,
  comments = [],
  onClose,
  onAddComment,
  onResolveComment,
  onDeleteComment,
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
    const aiContext = serializeForAI(el, { redactText });
    onAddComment?.({
      anchor: redactText ? redactAnchor(selectedAnchor) : selectedAnchor,
      scope: 'this',
      aiContext,
      text,
    });
    setDraft('');
  }, [draft, el, selectedAnchor, onAddComment, redactText]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isImeEnter(e)) return;
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

  // 定位统一走 overlay-rect（2026-07-31）。
  //
  // 老代码是 `elRect.left * zoom` 直接当 overlay 坐标用，少了 iframe 在容器里的
  // 位移。而 iframe 在 deck 和站点窗里都是**居中**的（HtmlIframe 用
  // align/justify-content: center，contain 语义缩放），只要窗口宽高比不等于画幅
  // 比例就必有一个轴存在居中留白，卡就整体偏那么多 —— 窗口越不方正偏得越狠，
  // 拉到接近 16:9 又自己好了，所以这个 bug 一直显得时有时无。
  //
  // 六个浮层 2026-07-30 统一收进 overlay-rect 时**漏了这一个**（和
  // PostDragNotePanel），文件头当时那句"位置算法保持不变"就是漏的证据。
  const base = overlayBase(iframeRef?.current)
    // 拿不到 offsetParent 时退回老行为（零位移），不至于整张卡不显示
    || { x: 0, y: 0, iframeRect };
  const { left: cardLeft, top: cardTop } = placeFloatingCard(base, elRect, zoom, {
    cardWidth: CARD_WIDTH,
    cardHeight: cardHeight || CARD_MAX_HEIGHT,
    offset: CARD_OFFSET,
  });

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
        background: COLOR.bgWhite,
        borderRadius: 2,
        boxShadow:
          '0 2px 4px rgba(43,33,23,0.04), 0 8px 20px rgba(43,33,23,0.08), 0 24px 48px rgba(43,33,23,0.10), inset 0 1px 0 rgba(255,254,246,0.8)',
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
        background: 'rgba(255,254,246,0.95)',
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
          background: 'rgba(43,33,23,0.05)',
          padding: `1px ${GAP.sm}px`,
          borderRadius: RADIUS.xs,
        }}>&lt;{tag}&gt;</span>
        <span style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
          flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {page?.index !== undefined && page.index !== null && `第 ${page.index} 页 · `}{role}
        </span>
        {offScreen && (
          <button
            onClick={scrollIntoView}
            title="滚动到该元素"
            style={{
              padding: GAP.xs, color: COLOR.text4, borderRadius: RADIUS.xs,
              background: 'rgba(43,33,23,0.04)',
            }}
          >
            <MapPin size={11} />
          </button>
        )}
        <button
          onClick={onClose}
          title="关闭（ESC）"
          style={{
            padding: GAP.xs, color: COLOR.text5, borderRadius: RADIUS.xs,
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
          background: 'rgba(43,33,23,0.015)',
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
              background: COLOR.bgWhite,
              boxShadow: PAPER_SHADOW.far,
              borderRadius: RADIUS.sm,
              resize: 'vertical',
              boxSizing: 'border-box',
              outline: 'none',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = COLOR.btn; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = COLOR.borderLt; }}
          />
        </div>
      </div>
    </div>
  );
}

function CommentRow({ comment, onResolve, onDelete }) {
  const resolved = comment.status === 'resolved';
  return (
    <div style={{
      padding: `${GAP.xs}px ${GAP.sm}px`,
      background: COLOR.bgWhite,
      boxShadow: PAPER_SHADOW.far,
      borderRadius: RADIUS.sm,
      display: 'flex', flexDirection: 'column', gap: GAP.xs,
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
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: GAP.xs,
      }}>
        <button
          onClick={onResolve}
          title={resolved ? '取消解决' : '标记解决'}
          style={{ padding: GAP.xxs, color: COLOR.sub, borderRadius: RADIUS.xs }}
        >
          <Check size={10} />
        </button>
        <button
          onClick={onDelete}
          title="删除"
          style={{ padding: GAP.xxs, color: COLOR.sub, borderRadius: RADIUS.xs }}
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}
