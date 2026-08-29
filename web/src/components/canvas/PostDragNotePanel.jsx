/**
 * PostDragNotePanel — 拖完浮在 source 旁的"follow-up 评论"输入框。
 *
 * P3 设计：drag 和 edit 分离 mode，但用一个 follow-up comment 复合两者：
 *   - 拖完即时浮出（不抢焦点，用户可选填）
 *   - 评论 push 时带 linkedToEditId 关联到刚才那条 pending-* item
 *   - agent 看到 comment.linkedToEditId 时把 comment 视为对该次 edit 的补充指令
 *
 * placeholder 文案对齐 agent prompt 的"默认保护邻居"启发式：用户多数情况下不需要担心
 * 邻居被改，agent 会自动做这件事；特殊指令再填评论。
 *
 * 取代 ConstraintPanel（anchor 9 选格在 NoDesign 固定尺寸 deck 场景下用处偏小，已砍 UI）。
 * 后端 constraint 字段 + drag-intent buildPendingStyleConstraint 保留，需要时 UI 可恢复。
 */

import { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, EDITOR } from '../../lib/theme.js';
import { serializeAnchor } from '../../lib/html-utils.js';
import { isImeEnter } from '../../lib/helpers.js';
import { overlayBase, placeFloatingCard } from '../../lib/overlay-rect.js';

const PANEL_WIDTH = 260;
// 面板高度随文本框内容变，钳位用一个够用的估值即可（宁可略高：估高只会让它
// 早一点上移，估低才会真的溢出容器底）
const PANEL_HEIGHT_EST = 180;

export default function PostDragNotePanel({
  active,                 // 拖完后 + sourceEl 存在时 true
  iframeRef,
  zoom = 1,
  sourceEl,               // 刚拖完的元素（DragOverlay lastSelectedSourceRef.current）
  hasPendingEditId,       // 有 linkedToEditId 才能提交（lastPendingEditId 还没设时 panel 也别接收输入）
  onSubmit,               // (sourceAnchor, text) => Promise<void>
  onDismiss,              // () => void —— 用户点 X 或 Esc 关闭
}) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef(null);
  const [, setTick] = useState(0);

  // 切换 sourceEl 时 reset 输入
  useEffect(() => {
    setText('');
  }, [sourceEl]);

  // 跟随 iframe scroll / resize 重定位
  useEffect(() => {
    if (!active || !iframeRef?.current) return undefined;
    const iframe = iframeRef.current;
    const win = iframe.contentWindow;
    if (!win) return undefined;
    let rafId = null;
    const trigger = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = null; setTick(t => t + 1); });
    };
    try {
      win.addEventListener('scroll', trigger, { passive: true, capture: true });
      win.addEventListener('resize', trigger);
      window.addEventListener('resize', trigger);
    } catch { /* */ }
    return () => {
      try {
        win.removeEventListener('scroll', trigger, { capture: true });
        win.removeEventListener('resize', trigger);
        window.removeEventListener('resize', trigger);
      } catch { /* */ }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [active, iframeRef]);

  // Esc 关闭（focus 在 textarea 内时也响应）
  useEffect(() => {
    if (!active) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, onDismiss]);

  if (!active || !sourceEl || !sourceEl.isConnected || !iframeRef?.current) return null;

  const base = overlayBase(iframeRef.current);
  if (!base) return null;
  const r = sourceEl.getBoundingClientRect();

  // 浮窗定位：贴 source 右侧浮出，钳在 iframe 视觉盒内。
  //
  // 2026-07-31 一并迁到 overlay-rect：老代码自己算 iframeRect - containerRect，
  // 少了容器的 scrollLeft/scrollTop（absolute 的包含块是容器 padding box，会跟着
  // 内容滚，视觉差里已经扣过一次滚动量，浏览器渲染时又扣一次）。这正是 07-30
  // 收敛掉的那个缺陷，当时漏了这个文件和 InspectFloatingCard 两个。
  const { left, top } = placeFloatingCard(base, r, zoom, {
    cardWidth: PANEL_WIDTH,
    cardHeight: PANEL_HEIGHT_EST,
    offset: 10,
  });

  const handleSubmit = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      const anchor = serializeAnchor(sourceEl);
      await onSubmit?.(anchor, text);
      setText('');
      onDismiss?.();
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    // Cmd/Ctrl+Enter 提交；普通 Enter 换行
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (isImeEnter(e)) return;
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top, left,
        width: PANEL_WIDTH,
        background: 'rgba(255,254,246,0.99)',
        border: `1px solid ${COLOR.borderHv}`,
        borderRadius: RADIUS.lg,
        boxShadow: '0 8px 24px rgba(93,74,44,0.165)',
        padding: GAP.md,
        zIndex: 45,
        fontFamily: FONT_MONO,
        pointerEvents: 'auto',
      }}
    >
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: GAP.sm,
      }}>
        <span style={{
          fontSize: FONT_SIZE.xxs, color: 'rgba(45,36,24,0.6)',
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}>
          可选备注 · 默认最小改动
        </span>
        <button
          onClick={() => onDismiss?.()}
          title="关闭（Esc）"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, padding: 0,
            background: 'transparent',
            border: 'none',
            color: 'rgba(45,36,24,0.4)',
            cursor: 'pointer',
            borderRadius: RADIUS.xs,
          }}
        >
          <X size={11} />
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        // 不自动 focus —— 用户拖完不一定想填，焦点抢过来会打断后续操作
        autoFocus={false}
        placeholder={`agent 落地时默认：\n· 把你拖到的位置实现到位\n· 拿邻居信息自己判断，让邻居尽量不动\n· 保留元素原本的响应式 / 尺寸 / 边距\n\n如有特殊指令请填……（Cmd+Enter 提交）`}
        rows={3}
        style={{
          width: '100%',
          padding: GAP.sm,
          fontFamily: 'inherit',
          fontSize: FONT_SIZE.sm,
          lineHeight: '15px',
          color: 'rgba(45,36,24,0.9)',
          background: 'rgba(43,33,23,0.02)',
          border: `1px solid ${COLOR.borderMd}`,
          borderRadius: RADIUS.sm,
          resize: 'vertical',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.sm, gap: GAP.xs }}>
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || submitting || !hasPendingEditId}
          title={
            !hasPendingEditId
              ? '没有关联的 pending edit（请先拖一次元素）'
              : !text.trim()
                ? '请填写备注内容'
                : '关联到本次调整 (Cmd+Enter)'
          }
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: `${GAP.xs}px ${GAP.base}px`,
            fontFamily: 'inherit', fontSize: FONT_SIZE.xs, fontWeight: 600,
            color: COLOR.bgWhite,
            background: EDITOR.blue,
            border: 'none',
            borderRadius: RADIUS.sm,
            cursor: (!text.trim() || submitting || !hasPendingEditId) ? 'not-allowed' : 'pointer',
            opacity: (!text.trim() || submitting || !hasPendingEditId) ? 0.4 : 1,
            boxShadow: '0 1px 3px rgba(58,122,254,0.25)',
          }}
        >
          <Send size={10} /> {submitting ? '提交中…' : '关联备注'}
        </button>
      </div>
    </div>
  );
}

