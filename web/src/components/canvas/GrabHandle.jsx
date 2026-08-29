/**
 * GrabHandle — drag mode active 时 hover 元素 → 显示虚线 outline + tag label 表达
 * "按下去就能拖这个"。
 *
 * P2 D 原本设计了一个独立 Move 按钮（Notion 风格）必须按按钮才能 drag，
 * 但用户反馈"按钮多余 + 鼠标移过去经常碰不到 hover state 丢"。改成：
 *   - 仍显示 hover preview 框（视觉提示用户"会抓住这个"）
 *   - mousedown 直接落在元素上即可启动 drag（DragOverlay 重新接 iframe doc mousedown）
 *   - 本组件**只剩视觉**职责，不再持 drag-start 入口
 *
 * pickDragSource 兜底 mousedown 选错 inline 元素的问题：mousedown 落到 span/svg
 * 时 DragOverlay 内部用同款 pickDragSource 向上找 block 祖先作为真 source。
 */

import { useEffect, useRef, useState } from 'react';
import { isInsideReactMount } from './DirectEditBridge.js';
import { overlayBase } from '../../lib/overlay-rect.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, EDITOR, alpha } from '../../lib/theme.js';

const HANDLE_COLOR = EDITOR.blue;
const HANDLE_COLOR_REACT = COLOR.warn;

export default function GrabHandle({
  active,           // drag mode 是否激活
  iframeRef,
  zoom = 1,
  pickDragSource,   // (rawEl, body) => HTMLElement | null —— 复用 DragOverlay 同款启发式
  isDragging,       // 拖动期间不显示 hover preview 避免视觉冲突
}) {
  const [hover, setHover] = useState(null);  // { source, rect, reactMount }
  const handleRef = useRef(null);
  const hideTimerRef = useRef(null);  // 鼠标离开 iframe → 200ms 后才清 hover，给用户时间移到 handle 上
  const [, setTick] = useState(0);

  const cancelHide = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => setHover(null), 200);
  };

  // 监听 iframe scroll / resize 重定位 handle
  useEffect(() => {
    if (!active) return undefined;
    const iframe = iframeRef?.current;
    if (!iframe) return undefined;
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

  // mousemove on iframe — 更新 hover 候选
  useEffect(() => {
    if (!active || isDragging) {
      setHover(null);
      return undefined;
    }
    const iframe = iframeRef?.current;
    if (!iframe) return undefined;
    const doc = iframe.contentDocument;
    if (!doc) return undefined;
    const body = doc.body;
    if (!body) return undefined;

    const onMove = (e) => {
      const raw = e.target;
      if (!raw || raw.nodeType !== 1 || raw === body || raw === doc.documentElement) {
        scheduleHide();
        return;
      }
      const cand = pickDragSource(raw, body);
      if (!cand) { scheduleHide(); return; }
      // 命中新 candidate → 取消之前的 hide timer
      cancelHide();
      setHover({
        source: cand,
        rect: cand.getBoundingClientRect(),
        reactMount: isInsideReactMount(cand),
      });
    };
    // iframe mouseleave 不立即清 hover —— 鼠标可能正向 handle 移动（handle 在 parent doc 里，
    // 物理上离开 iframe 区域）。200ms grace period 让 handle 的 mouseEnter 来取消 hide。
    const onLeave = () => scheduleHide();

    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseleave', onLeave);
    return () => {
      try {
        doc.removeEventListener('mousemove', onMove, true);
        doc.removeEventListener('mouseleave', onLeave);
      } catch { /* */ }
      cancelHide();
    };
  }, [active, iframeRef, pickDragSource, isDragging]);

  if (!active || !hover || isDragging || !iframeRef?.current) return null;

  const iframe = iframeRef.current;
  const base = overlayBase(iframe);
  if (!base) return null;

  const r = hover.rect;
  const color = hover.reactMount ? HANDLE_COLOR_REACT : HANDLE_COLOR;
  const previewTop = base.y + r.top * zoom - 2;
  const previewLeft = base.x + r.left * zoom - 2;
  const previewW = r.width * zoom + 4;
  const previewH = r.height * zoom + 4;

  return (
    <>
      {/* hover preview 框 —— 视觉提示"按下去会抓住这个" */}
      <div style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: previewTop,
        left: previewLeft,
        width: previewW,
        height: previewH,
        border: `2px dashed ${color}`,
        borderRadius: RADIUS.sm,
        background: hover.reactMount ? 'rgba(184,92,26,0.04)' : alpha(EDITOR.blue, 0.04),
        boxShadow: `0 0 0 1px ${hover.reactMount ? 'rgba(184,92,26,0.15)' : alpha(EDITOR.blue, 0.15)}`,
        zIndex: 8,
      }} />
      {/* 顶部 tag label —— 告诉用户这个框是 drag target + 是否 React 区 */}
      <div style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: previewTop - 18,
        left: previewLeft,
        padding: `1px ${GAP.sm}px`,
        fontFamily: FONT_MONO,
        fontSize: FONT_SIZE.xxs,
        lineHeight: '14px',
        fontWeight: 500,
        color: COLOR.bgWhite,
        background: color,
        borderRadius: RADIUS.xs,
        whiteSpace: 'nowrap',
        boxShadow: `0 1px 3px ${hover.reactMount ? 'rgba(184,92,26,0.3)' : alpha(EDITOR.blue, 0.3)}`,
        zIndex: 9,
      }}>
        {hover.reactMount ? '⊕ 拖动（React 区·改 JSX）' : '⊕ 拖动 ' + (hover.source.tagName?.toLowerCase() || '')}
      </div>
    </>
  );
}
