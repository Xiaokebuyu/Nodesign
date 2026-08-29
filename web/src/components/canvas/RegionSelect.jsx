import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, X, Loader2 } from 'lucide-react';
import { overlayBase } from '../../lib/overlay-rect.js';
import { serializeStableAnchor } from '../../lib/html-utils.js';
import { pickRegionElements, pickRegionContainer, normalizeRect, isMeaningfulRegion } from '../../lib/region-pick.js';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * RegionSelect —— 在预览上圈一块地方说事（2026-08-07）
 *
 * 已有的评论是**点一个元素**说事。可有一半的话根本不是对着某一个元素说的：
 * 「这一整块太挤」「这三张卡片对不齐」「右下角这片留白怪」—— 指的是一片
 * 区域和它们之间的关系。点选逼着用户把这种意思拆成几条元素评论，或者干脆
 * 放弃改用文字描述位置（"上面第二排那个"），两条路都在丢信息。
 *
 * 圈选给的是三样东西一起走：
 *   1. **框住了谁** —— 见 region-pick.js，那里定的是「这一圈指的是哪些元素」
 *   2. **当时长什么样** —— 服务端 chromium 把那块真截一张（lib/region-shot.js）
 *   3. **想说什么** —— 一句话，可以为空（框本身就是话）
 *
 * 三样进同一条 pending-changes buffer，agent 下一轮照常 get_pending_changes
 * 拿到，图直接挂在工具结果里。跟点选评论走的是同一条路，不是另起一套。
 *
 * ## 坐标
 *
 * 三套坐标，别混：
 *   - **overlay**：这层浮层自己的坐标系（iframe.offsetParent 的 padding box），
 *     画框用它
 *   - **inner**：iframe 内部视口坐标，`getBoundingClientRect()` 给的就是这个，
 *     算相交用它
 *   - **page**：inner + 文档滚动量，截图要它（服务端得知道滚到哪儿）
 */

/** 不参与圈选的：没有视觉、或者大到没有意义 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'BR', 'HTML', 'BODY']);

const PANEL_W = 300;

/** 元素 → 交给 agent 的那点信息（够它认出是谁，不够的它自己去读源码） */
function describe(el, sx, sy) {
  const r = el.getBoundingClientRect();
  return {
    anchor: serializeStableAnchor(el),
    tag: el.tagName.toLowerCase(),
    ...(el.id ? { id: el.id } : {}),
    ...(typeof el.className === 'string' && el.className ? { class: el.className.slice(0, 80) } : {}),
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    rect: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

export default function RegionSelect({
  active,
  iframeRef,
  zoom = 1,
  onSubmit,          // ({ region, viewport, elements, text }) => Promise
  onExit,            // 退出圈选模式（发完 / 取消）
}) {
  const [drag, setDrag] = useState(null);        // { from:{x,y}, to:{x,y} } overlay 坐标
  const [pending, setPending] = useState(null);  // 画完待确认
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [, setTick] = useState(0);
  const layerRef = useRef(null);

  // 容器滚动 / 窗口缩放会让 base 变，浮层得跟着重算
  useEffect(() => {
    if (!active) return undefined;
    const onAny = () => setTick(t => t + 1);
    window.addEventListener('resize', onAny);
    return () => window.removeEventListener('resize', onAny);
  }, [active]);

  // 退出圈选模式时把半成品清掉，免得下次进来还挂着上次的框
  useEffect(() => {
    if (!active) { setDrag(null); setPending(null); setText(''); }
  }, [active]);

  const cancel = useCallback(() => {
    setDrag(null); setPending(null); setText('');
  }, []);

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

  const iframe = iframeRef?.current;
  const base = active && iframe ? overlayBase(iframe) : null;
  if (!active || !base) return null;
  const doc = iframe.contentDocument;
  if (!doc) return null;

  const boxW = base.iframeRect.width;
  const boxH = base.iframeRect.height;

  /** 指针 client 坐标 → overlay 坐标（夹在取景框内，别让框跑到画布空白上） */
  const toOverlay = (e) => {
    const r = layerRef.current.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - r.left), boxW),
      y: Math.min(Math.max(0, e.clientY - r.top), boxH),
    };
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || pending) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toOverlay(e);
    setDrag({ from: p, to: p });
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    e.stopPropagation();
    setDrag(d => (d ? { ...d, to: toOverlay(e) } : d));
  };

  const onPointerUp = (e) => {
    if (!drag) return;
    e.stopPropagation();
    const box = normalizeRect(drag.from, drag.to);
    setDrag(null);
    if (!isMeaningfulRegion(box)) return;   // 手抖点一下：当没画

    // overlay → inner（iframe 内部视口坐标）
    const inner = { x: box.x / zoom, y: box.y / zoom, w: box.w / zoom, h: box.h / zoom };

    const candidates = [];
    for (const el of doc.body.querySelectorAll('*')) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      candidates.push({ el, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }
    const picked = pickRegionElements(candidates, inner);
    const holder = pickRegionContainer(candidates, inner);

    // inner → page（截图要绝对文档坐标）
    const se = doc.scrollingElement || doc.documentElement;
    const sx = se?.scrollLeft || 0;
    const sy = se?.scrollTop || 0;
    const win = iframe.contentWindow;

    setPending({
      box,
      region: {
        x: Math.round(inner.x + sx), y: Math.round(inner.y + sy),
        w: Math.round(inner.w), h: Math.round(inner.h),
      },
      viewport: {
        width: Math.round(win?.innerWidth || boxW / zoom),
        height: Math.round(win?.innerHeight || boxH / zoom),
      },
      // 「这块地方在页面的哪儿」—— 光给一串 <div> agent 分不清页头页脚
      container: holder ? describe(holder.el, sx, sy) : null,
      elements: picked.map(({ el, coverage }) => ({
        ...describe(el, sx, sy),
        coverage: Math.round(coverage * 100) / 100,
      })),
    });
  };

  const send = async () => {
    if (!pending || sending) return;
    setSending(true);
    try {
      await onSubmit?.({
        region: pending.region,
        viewport: pending.viewport,
        container: pending.container,
        elements: pending.elements,
        text: text.trim(),
      });
      cancel();
      onExit?.();
    } finally {
      setSending(false);
    }
  };

  const live = drag ? normalizeRect(drag.from, drag.to) : null;
  const shown = pending?.box || live;

  // 确认面板贴在框下方，装不下翻到上方，再夹进取景框
  let panelTop = 0; let panelLeft = 0;
  if (pending) {
    const b = pending.box;
    panelTop = b.y + b.h + 10;
    if (panelTop + 190 > boxH) panelTop = Math.max(8, b.y - 190 - 10);
    panelLeft = Math.min(Math.max(8, b.x), Math.max(8, boxW - PANEL_W - 8));
  }

  return (
    <div
      ref={layerRef}
      data-no-pan
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      style={{
        position: 'absolute',
        left: base.x, top: base.y, width: boxW, height: boxH,
        zIndex: 40,
        cursor: pending ? 'default' : 'crosshair',
        // 画的时候压一层薄暗，让"现在在圈"这件事一眼可辨
        background: pending ? 'transparent' : 'rgba(32,26,14,0.10)',
        touchAction: 'none',
      }}
    >
      {shown && (
        <>
          {/* 框外压暗，框内透亮 —— 用四条边比 clip-path 稳 */}
          <div style={{
            position: 'absolute',
            left: shown.x, top: shown.y, width: shown.w, height: shown.h,
            border: `2px solid ${COLOR.btn}`,
            borderRadius: RADIUS.sm,
            background: 'rgba(255,254,246,0.06)',
            boxShadow: '0 0 0 9999px rgba(32,26,14,0.18)',
            pointerEvents: 'none',
          }} />
          {pending && (
            <div style={{
              position: 'absolute',
              left: shown.x, top: Math.max(0, shown.y - 20),
              padding: '1px 7px', borderRadius: RADIUS.sm,
              background: COLOR.text, color: COLOR.bgWhite,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}>
              框住 {pending.elements.length} 个元素
            </div>
          )}
        </>
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
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5 }}>
            {pending.elements.slice(0, 3).map(e => `<${e.tag}>${e.text ? ` ${e.text.slice(0, 14)}` : ''}`).join('、')}
            {pending.elements.length > 3 ? ` 等 ${pending.elements.length} 个` : ''}
          </div>
          <textarea
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
            }}
            placeholder="这一块想说什么…（可以不写，框本身就是话）"
            style={{
              width: '100%', boxSizing: 'border-box', minHeight: 64, resize: 'vertical',
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
                ? <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> 截图中…</>
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
