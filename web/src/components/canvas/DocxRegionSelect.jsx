import { useState, useEffect, useCallback } from 'react';
import { Send, X, Loader2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * DocxRegionSelect —— 在 word 文档的**页图**上圈一块说事（2026-08-19）
 *
 * 跟 RegionSelect（deck / site 版）是同一个动作、不同的地基：那边是 iframe 里的
 * 活网页，圈完要在 DOM 里挑"框住了谁"、让服务端起 chromium 截那块；这边没有
 * DOM —— 用户看的就是 LibreOffice 渲出来的一张位图，所以三件事缩成两件：
 * 框在页图的哪儿（换算成页图原始像素交给服务端裁）+ 想说什么。
 * 「框住了哪些元素」这一维天然不存在，这是能力边界不是偷懒 —— 人批注纸质
 * 文档本来就是圈一块说事。
 *
 * 坐标：拖拽收集的是**显示坐标**（img 可能被 fit 缩放过），提交前按
 * naturalWidth / clientWidth 换算成页图原始像素 —— 服务端不知道用户把页面
 * 缩成了多大，页图像素是双方唯一共享的坐标系。
 */

/** 手抖点一下不算圈（显示像素） */
const MIN_BOX = 8;

const PANEL_W = 280;

export default function DocxRegionSelect({
  active,
  /** 页图 <img> 的 ref（换算比例、限定圈选范围都要它） */
  imgRef,
  onSubmit,          // ({ region, viewport, text }) => Promise —— region 已是页图像素
  onExit,
}) {
  const [drag, setDrag] = useState(null);        // { from:{x,y}, to:{x,y} } 显示坐标
  const [pending, setPending] = useState(null);  // { box } 画完待确认
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const cancel = useCallback(() => { setDrag(null); setPending(null); setText(''); }, []);

  // 退出圈选模式 / 换页换文档（active 由父层在那时收回）都把半成品清掉
  useEffect(() => { if (!active) cancel(); }, [active, cancel]);

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (pending || drag) cancel();
      else onExit?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, pending, drag, cancel, onExit]);

  if (!active) return null;

  const local = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - r.left), r.width),
      y: Math.min(Math.max(0, e.clientY - r.top), r.height),
    };
  };
  const norm = (a, b) => ({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
  });

  const onPointerDown = (e) => {
    if (e.button !== 0 || pending) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = local(e);
    setDrag({ from: p, to: p });
  };
  const onPointerMove = (e) => {
    if (!drag) return;
    e.stopPropagation();
    const p = local(e);
    setDrag(d => (d ? { ...d, to: p } : d));
  };
  const onPointerUp = () => {
    if (!drag) return;
    const box = norm(drag.from, drag.to);
    setDrag(null);
    if (box.w < MIN_BOX || box.h < MIN_BOX) return;
    setPending({ box });
  };

  const send = async () => {
    if (!pending || sending) return;
    const img = imgRef?.current;
    if (!img || !img.naturalWidth || !img.clientWidth) return;
    const scale = img.naturalWidth / img.clientWidth;
    const b = pending.box;
    setSending(true);
    try {
      await onSubmit?.({
        region: {
          x: Math.round(b.x * scale), y: Math.round(b.y * scale),
          w: Math.round(b.w * scale), h: Math.round(b.h * scale),
        },
        viewport: { width: img.naturalWidth, height: img.naturalHeight },
        text: text.trim(),
      });
      cancel();
      onExit?.();
    } finally {
      setSending(false);
    }
  };

  const live = drag ? norm(drag.from, drag.to) : null;
  const shown = pending?.box || live;

  // 确认面板贴框下方，装不下翻到上方（同 RegionSelect 的摆法）
  let panelTop = 0; let panelLeft = 0;
  if (pending && imgRef?.current) {
    const b = pending.box;
    const boxH = imgRef.current.clientHeight;
    const boxW = imgRef.current.clientWidth;
    panelTop = b.y + b.h + 10;
    if (panelTop + 170 > boxH) panelTop = Math.max(8, b.y - 170 - 10);
    panelLeft = Math.min(Math.max(8, b.x), Math.max(8, boxW - PANEL_W - 8));
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      style={{
        position: 'absolute', inset: 0,
        cursor: pending ? 'default' : 'crosshair',
        background: pending ? 'transparent' : 'rgba(32,26,14,0.10)',
        touchAction: 'none', borderRadius: 2,
      }}
    >
      {shown && (
        <div style={{
          position: 'absolute',
          left: shown.x, top: shown.y, width: shown.w, height: shown.h,
          border: `2px solid ${COLOR.btn}`,
          borderRadius: RADIUS.sm,
          background: 'rgba(255,254,246,0.06)',
          boxShadow: '0 0 0 9999px rgba(32,26,14,0.18)',
          pointerEvents: 'none',
        }} />
      )}

      {pending && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', left: panelLeft, top: panelTop, width: PANEL_W,
            background: COLOR.bgWhite, borderRadius: RADIUS.lg,
            boxShadow: PAPER_SHADOW.far, padding: GAP.md,
            display: 'flex', flexDirection: 'column', gap: GAP.sm,
          }}
        >
          <textarea
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
            }}
            placeholder="这一块想说什么…（可以不写，框本身就是话）"
            style={{
              width: '100%', boxSizing: 'border-box', minHeight: 56, resize: 'vertical',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.6,
              border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
              padding: GAP.sm, outline: 'none', background: COLOR.bg,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
            <button
              onClick={send}
              disabled={sending}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
                padding: `5px ${GAP.lg}px`, borderRadius: RADIUS.pill, border: 'none',
                background: COLOR.btn, color: COLOR.btnText,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600,
                cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.7 : 1,
              }}
            >
              {sending
                ? <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> 发送中…</>
                : <><Send size={12} /> 发给 agent</>}
              <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
            </button>
            <button
              onClick={cancel}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
                padding: `5px ${GAP.md}px`, borderRadius: RADIUS.pill,
                border: `1px solid ${COLOR.borderLt}`, background: 'transparent', color: COLOR.sub,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, cursor: 'pointer',
              }}
            >
              <X size={11} /> 重画
            </button>
            <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.dim }}>
              ⌘↵
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
