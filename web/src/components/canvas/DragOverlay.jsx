/**
 * DragOverlay — 画布拖移工具的视觉 + iframe 事件 handler
 *
 * 职责：
 *   - active 时给 iframe 内挂 mousedown / mousemove / mouseup / keydown
 *   - 用户按下选中目标 → 拖动时 ghost 跟手 + 显示 caret + 对齐 guide + 距离标注
 *   - 用户松手 → 调 onCommitMove(payload)；payload 含 source + target + alignmentHints
 *
 * 坐标系：
 *   - iframe 内部 viewport 坐标（getBoundingClientRect / elementFromPoint）
 *   - overlay 是 iframeWrapRef 的 absolute child，画的时候要做 zoom + 偏移换算
 *   - 套路：(iframeRect.{top,left} + innerCoord * zoom) - containerRect.{top,left}
 *
 * React mount 区域：
 *   - 拖动时不动 DOM（避免被 React next render 覆盖立即跳回）
 *   - 仅靠 ghost overlay 显示意图；松手时仍 push pending-move（reactMount: true）
 *   - DragOverlay 只关心视觉；DOM mutation 由 onCommitMove 回调里调用方决定
 */

import { useEffect, useRef, useState } from 'react';
import {
  findDropContainer,
  computeDropIntent,
  computeAlignmentGuides,
  computeDistanceLabels,
  collectNeighbors,
  buildPendingMove,
  buildPendingStyleAbsolute,
  lockAxis,
  snapToGuides,
  computeSmartSpacing,
} from '../../lib/drag-intent.js';
import { isInsideReactMount } from './DirectEditBridge.js';
import { overlayBase, toOverlayXY } from '../../lib/overlay-rect.js';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, EDITOR, alpha } from '../../lib/theme.js';

const GHOST_COLOR = 'rgba(43,33,23, 0.85)';        // 跟 EditOverlay 一致的深棕
const CARET_COLOR = EDITOR.blue;                      // 亮蓝（区别于评论橙）
const ALIGN_COLOR = EDITOR.magenta;                   // Figma 风格洋红 guide
const DISTANCE_BG  = EDITOR.blue;
const DRAG_THRESHOLD = 3;                             // mousedown 到 move 至少 3px 才算拖（避免误触）

export default function DragOverlay({
  active,
  iframeRef,
  zoom = 1,
  freeMode = false,                  // controlled — 由外层（CanvasFrame state）持
  onFreeModeChange,                  // (next: bool) => void —— P 键也调它
  onCommitMove,                      // (payload, refs) => void —— 拖完一个 DOM 树 move
  onCommitFreePosition,              // (payload, refs) => void —— 拖完一个绝对定位 (position: absolute) 编辑
  onCancel,                          // () => void —— Esc / 拖到 invalid 区
  apiRef,                            // P2 D: GrabHandle 通过此 ref 调 .startDrag(sourceEl, internalX, internalY)
  onDraggingChange,                  // (isDragging: bool) => void —— 让 GrabHandle 拖动期间隐藏
  onSelectionChange,                 // (sourceEl) => void —— 拖完后保留 selection，告知外层显 PostDragNotePanel
}) {
  // === drag state ===
  const [drag, setDrag] = useState(null);   // null | { source, sourceRect, ghostRect, dropTarget, dropIntent, alignGuides, distanceLabels, reactMount, freeMode }
  const [landingFlash, setLandingFlash] = useState(null);  // { rect, ts } —— mouseup 后 source 新位置短暂发光确认
  const [, setTick] = useState(0);

  // 重渲染 ticker（iframe scroll / resize 时）
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
    } catch { /* cross-origin */ }
    return () => {
      try {
        win.removeEventListener('scroll', trigger, { capture: true });
        win.removeEventListener('resize', trigger);
        window.removeEventListener('resize', trigger);
      } catch { /* */ }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [active, iframeRef]);

  // iframe 内部事件挂载
  useEffect(() => {
    if (!active) return undefined;
    const iframe = iframeRef?.current;
    if (!iframe) return undefined;
    const doc = safeDoc(iframe);
    if (!doc) return undefined;
    const body = doc.body;
    if (!body) return undefined;

    // 进入拖移模式时给 body 禁掉文字选择（拖动期间不要选中文字）
    const prevUserSelect = body.style.userSelect;
    body.style.userSelect = 'none';

    let local = { source: null, startX: 0, startY: 0, started: false, altKey: false, autoFree: false };

    // iframe 内 mousedown 启动 drag —— P1 模式 + pickDragSource 兜底 inline 元素
    // Alt-drag 复制：mousedown 时按住 Alt → 落地走 pending-duplicate（保留原元素位置）
    const handleDown = (e) => {
      if (e.button !== 0) return;
      const raw = e.target;
      if (!raw || raw.nodeType !== 1 || raw === body || raw === doc.documentElement) return;
      const source = pickDragSource(raw, body);
      if (!source) return;
      e.preventDefault();
      e.stopPropagation();
      // 绝对/固定定位的元素自动走"坐标语义"（= 自由模式）：这类元素的视觉位置
      // 由 top/left 决定、与 DOM 顺序解耦，按 DOM 插入语义拖它只会改出
      // "画面没变但结构变了"的静默事故（拼贴版式的 h1 被塞进天空图那类）。
      let autoFree = false;
      try {
        const pos = doc.defaultView.getComputedStyle(source).position;
        autoFree = pos === 'absolute' || pos === 'fixed';
      } catch { /* */ }
      // mousedown 在 iframe doc 内 —— e.clientX/Y 已经是 iframe 内部坐标，无需转换
      local = {
        source,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        altKey: e.altKey,  // 记下"是否复制"，松手时按这个分流 move vs duplicate
        autoFree,
      };
      onDraggingChangeRef.current?.(true);
    };

    // apiRef 路径保留作为扩展点（可关闭——GrabHandle 不再调它）
    const startDragFromHandle = (sourceEl, parentX, parentY) => {
      if (!sourceEl) return;
      const internal = parentToIframeCoord(iframe, parentX, parentY, zoom);
      local = {
        source: sourceEl,
        startX: internal.x,
        startY: internal.y,
        started: false,
        altKey: false,
        autoFree: false,
      };
      onDraggingChangeRef.current?.(true);
    };
    if (apiRef) apiRef.current = { startDrag: startDragFromHandle, pickDragSource };

    const handleMove = (e) => {
      if (!local.source) return;
      // mousemove 可能来自 iframe doc（e.view === iframe.contentWindow，clientX/Y 已是内部坐标）
      // 或 parent window（clientX/Y 是 parent doc 坐标，要转换）
      let mouseX, mouseY;
      if (e.view === iframe.contentWindow) {
        mouseX = e.clientX;
        mouseY = e.clientY;
      } else {
        const internal = parentToIframeCoord(iframe, e.clientX, e.clientY, zoom);
        mouseX = internal.x;
        mouseY = internal.y;
      }
      const dx = mouseX - local.startX;
      const dy = mouseY - local.startY;
      if (!local.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        local.started = true;
      }
      e.preventDefault();
      // 算 ghost rect = source 原 rect + dx/dy
      const sourceRect = local.source.getBoundingClientRect();
      let ghostRect = {
        left: sourceRect.left + dx,
        top: sourceRect.top + dy,
        right: sourceRect.right + dx,
        bottom: sourceRect.bottom + dy,
        width: sourceRect.width,
        height: sourceRect.height,
      };
      // Shift 锁轴 —— 限制 ghost 只走主方向
      if (e.shiftKey) {
        ghostRect = lockAxis(ghostRect, sourceRect, dx, dy);
      }
      // hit-test 用 ghost 中心点
      const hitX = ghostRect.left + ghostRect.width / 2;
      const hitY = ghostRect.top + ghostRect.height / 2;
      // 自由模式（freeMode）只算 ghost 跟手 + 距离 alignment，不算 dropTarget/caret
      // —— absolute 定位的语义是"落到任意像素位置"，没有"插入哪个容器"的概念
      const inFreeMode = freeModeRef.current || local.autoFree;
      let dropInfo = null;
      let dropIntent = null;
      let alignGuides = [];
      let distanceLabels = [];
      // 记下最新 event 给 dwell timer fire 时再次评估
      lastMouseEventRef.current = e;
      if (!inFreeMode) {
        // 临时隐藏 source 让 elementFromPoint 别命中自己
        const prevPe = local.source.style.pointerEvents;
        local.source.style.pointerEvents = 'none';
        const hit = doc.elementFromPoint(hitX, hitY);
        local.source.style.pointerEvents = prevPe;
        dropInfo = hit ? findDropContainer(hit, local.source, body) : null;
        if (dropInfo) {
          // P2: 3 分流 drop intent —— 按鼠标在 hit child 内的位置区域返回不同 intent
          dropIntent = computeDropIntent(dropInfo.container, hit, local.source, { x: hitX, y: hitY });
          const neighbors = collectNeighbors(dropInfo.container, local.source);
          alignGuides = computeAlignmentGuides(ghostRect, neighbors);
          distanceLabels = computeDistanceLabels(ghostRect, neighbors);

          // C: dwell delay —— child-of 必须停留 150ms 才算"真的想进入"
          if (dropIntent && dropIntent.intent === 'child-of') {
            const tgt = dropIntent.hitChild;
            const now = Date.now();
            if (committedChildRef.current === tgt) {
              // 已 dwell 过，保持 child-of
            } else if (candidateChildRef.current.hitChild === tgt) {
              // 同一候选，看够不够 150ms
              if (now - candidateChildRef.current.ts >= 150) {
                committedChildRef.current = tgt;
              } else {
                // 还没到时间 → 临时降级成 sibling-after 让用户看到 caret 而不是"进入"区
                dropIntent = downgradeToSiblingAfter(dropIntent);
              }
            } else {
              // 新候选 → 重置 dwell 计时
              candidateChildRef.current = { hitChild: tgt, ts: now };
              committedChildRef.current = null;
              dropIntent = downgradeToSiblingAfter(dropIntent);
              // 150ms 后强制 re-fire 一次 move 让 commit 生效（用户停住手时也能进入容器）
              if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
              dwellTimerRef.current = setTimeout(() => {
                dwellTimerRef.current = null;
                if (local.source && lastMouseEventRef.current) {
                  handleMove(lastMouseEventRef.current);
                }
              }, 160);
            }
          } else {
            // intent 不是 child-of → 清候选 + committed
            candidateChildRef.current = { hitChild: null, ts: 0 };
            committedChildRef.current = null;
            if (dwellTimerRef.current) {
              clearTimeout(dwellTimerRef.current);
              dwellTimerRef.current = null;
            }
          }
        }
      } else {
        // 自由模式仍算对齐 guide / 距离标注（跟周围元素 snap 对齐用）
        const parent = local.source.parentElement;
        if (parent) {
          const neighbors = collectNeighbors(parent, local.source);
          alignGuides = computeAlignmentGuides(ghostRect, neighbors);
          distanceLabels = computeDistanceLabels(ghostRect, neighbors);
        }
      }

      // 自由模式 + 嵌入模式都做 Snap to guide（吸附到对齐线）—— guide 出现时
      // ghost 鼠标位置在 ±3px 内自动 snap 到 guide 值
      if (alignGuides.length > 0) {
        ghostRect = snapToGuides(ghostRect, alignGuides, 3);
      }

      // Smart spacing —— 自由模式才意义大（嵌入模式有 flex/grid gap 自己管）
      let smartSpacing = [];
      if (inFreeMode) {
        const parent = local.source.parentElement;
        if (parent) {
          const neighbors = collectNeighbors(parent, local.source);
          smartSpacing = computeSmartSpacing(ghostRect, neighbors);
        }
      }

      setDrag({
        source: local.source,
        sourceRect,
        ghostRect,
        dropTarget: dropInfo,
        dropIntent,
        alignGuides,
        distanceLabels,
        smartSpacing,
        reactMount: isInsideReactMount(local.source),
        freeMode: inFreeMode,
        autoFree: local.autoFree,
        duplicate: local.altKey,
      });
    };

    const handleUp = (e) => {
      if (!local.source) return;
      const wasStarted = local.started;
      const src = local.source;
      const drop = wasStarted ? lastDropTargetRef.current : null;
      const dropIntent = wasStarted ? lastDropIntentRef.current : null;
      const align = wasStarted ? lastAlignRef.current : [];
      const ghostR = wasStarted ? lastGhostRectRef.current : null;
      const inFree = freeModeRef.current || local.autoFree;
      const isDuplicate = local.altKey;
      local = { source: null, startX: 0, startY: 0, started: false, altKey: false, autoFree: false };
      setDrag(null);
      onDraggingChangeRef.current?.(false);
      // 不再自动关 freeMode —— 由外层 toggle 控制持久状态
      if (!wasStarted) return;

      // ── 自由模式：落地为 absolute (position: absolute + left/top) ──────
      if (inFree && ghostR) {
        const parent = src.parentElement;
        if (!parent) {
          onCancelRef.current?.();
          return;
        }
        const parentRect = parent.getBoundingClientRect();
        const left = Math.round(ghostR.left - parentRect.left);
        const top  = Math.round(ghostR.top  - parentRect.top);
        const payload = buildPendingStyleAbsolute({ sourceEl: src, parentEl: parent, left, top });
        if (payload) {
          onCommitFreePositionRef.current?.(payload, { sourceEl: src, parentEl: parent, left, top });
          lastSelectedSourceRef.current = src;  // 留 selection 给键盘 nudge
          onSelectionChangeRef.current?.(src);
          requestAnimationFrame(() => {
            try {
              setLandingFlash({ rect: src.getBoundingClientRect(), ts: Date.now() });
              setTimeout(() => setLandingFlash(null), 350);
            } catch { /* */ }
          });
        }
        return;
      }

      // ── 嵌入模式：按 dropIntent 落地 ──────
      if (!drop || !dropIntent) {
        onCancelRef.current?.();
        return;
      }
      const hints = align.map(g => alignHintLabel(g));
      const finalContainer = dropIntent.targetContainer;
      const finalBefore = dropIntent.beforeEl;
      const payload = buildPendingMove({
        sourceEl: src,
        targetContainer: finalContainer,
        beforeEl: finalBefore,
        intent: dropIntent.intent,
        alignmentHints: hints,
      });
      if (payload) {
        // Alt-drag → 改 kind 为 pending-duplicate；agent 落地时保留 source 原位置 + clone 到 target
        if (isDuplicate) payload.duplicate = true;
        onCommitMoveRef.current?.(payload, { sourceEl: src, targetContainer: finalContainer, beforeEl: finalBefore, duplicate: isDuplicate });
        lastSelectedSourceRef.current = src;  // 留 selection 给键盘 nudge
        onSelectionChangeRef.current?.(src);
        requestAnimationFrame(() => {
          try {
            const newRect = src.getBoundingClientRect();
            setLandingFlash({ rect: newRect, ts: Date.now() });
            setTimeout(() => setLandingFlash(null), 350);
          } catch { /* ignore */ }
        });
      }
    };

    const handleKey = (e) => {
      if (e.key === 'Escape' && local.source) {
        e.preventDefault();
        local = { source: null, startX: 0, startY: 0, started: false, altKey: false, autoFree: false };
        setDrag(null);
        onDraggingChangeRef.current?.(false);
        onCancelRef.current?.();
        return;
      }
      // P 键切换"自由模式" —— controlled prop，受 onFreeModeChange 控制
      if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onFreeModeChangeRef.current?.(!freeModeRef.current);
        return;
      }
      // 键盘 nudge —— 自由模式下方向键 1px / Shift+方向键 10px 微调选中元素位置
      const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (arrowKeys.includes(e.key) && lastSelectedSourceRef.current && freeModeRef.current) {
        const sel = lastSelectedSourceRef.current;
        if (!sel.isConnected) {
          lastSelectedSourceRef.current = null;
          return;
        }
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0;
        const curLeft = parseFloat(sel.style.left) || 0;
        const curTop  = parseFloat(sel.style.top)  || 0;
        const newLeft = Math.round(curLeft + dx);
        const newTop  = Math.round(curTop  + dy);
        const parent = sel.parentElement;
        // 复用 buildPendingStyleAbsolute 算 payload —— 它把 left/top 当 px 数组装好
        const payload = buildPendingStyleAbsolute({
          sourceEl: sel, parentEl: parent, left: newLeft, top: newTop,
        });
        if (payload) {
          onCommitFreePositionRef.current?.(payload, { sourceEl: sel, parentEl: parent, left: newLeft, top: newTop });
        }
      }
    };

    // mousedown 监听 iframe doc（用户点击 iframe 内元素启动 drag）。
    // mousemove/mouseup 监听 parent window —— 鼠标拖动期间可能离开 iframe，
    // window 更稳。iframe doc 同时也挂 mousemove/up 一份兜底。
    doc.addEventListener('mousedown', handleDown, true);
    window.addEventListener('mousemove', handleMove, true);
    window.addEventListener('mouseup', handleUp, true);
    window.addEventListener('keydown', handleKey);
    doc.addEventListener('mousemove', handleMove, true);
    doc.addEventListener('mouseup', handleUp, true);
    doc.addEventListener('keydown', handleKey, true);
    return () => {
      try {
        doc.removeEventListener('mousedown', handleDown, true);
        window.removeEventListener('mousemove', handleMove, true);
        window.removeEventListener('mouseup', handleUp, true);
        window.removeEventListener('keydown', handleKey);
        doc.removeEventListener('mousemove', handleMove, true);
        doc.removeEventListener('mouseup', handleUp, true);
        doc.removeEventListener('keydown', handleKey, true);
      } catch { /* */ }
      body.style.userSelect = prevUserSelect;
      if (apiRef) apiRef.current = null;
      if (dwellTimerRef.current) {
        clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
      candidateChildRef.current = { hitChild: null, ts: 0 };
      committedChildRef.current = null;
    };
    // 关键：deps 不依赖 inline arrow callbacks（onCommitMove 等）—— 它们走 ref 读最新值。
    // re-mount 会重置 effect 内 `local` state，正在 mousedown 中的拖动会瞬间失效（拖不动）。
    // iframeRef.current 在 active=true 时已稳定指向 iframe DOM，无需进 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, zoom]);

  // 给 handleUp 提供"上一次 mousemove 的 dropTarget / dropIntent / align / ghostRect"快照
  // —— mouseup 时拿不到最新 drag state（setState 异步），用 ref 抓
  const lastDropTargetRef = useRef(null);
  const lastDropIntentRef = useRef(null);
  const lastAlignRef = useRef([]);
  const lastGhostRectRef = useRef(null);
  const freeModeRef = useRef(false);
  // C: child-of dwell delay 150ms —— 防止快速划过容器误触"进入"
  //    candidateChildRef = { hitChild, ts } 记录"用户停在这个 hitChild 上多久了"
  //    committedChildRef = "已确认 dwell 过的 hitChild"，再次命中不需要重新等
  //    dwellTimerRef = setTimeout id 让 timer 到期后能强制 re-fire 一次 move 来 commit
  const candidateChildRef = useRef({ hitChild: null, ts: 0 });
  const committedChildRef = useRef(null);
  const dwellTimerRef = useRef(null);
  const lastMouseEventRef = useRef(null);
  // 自由模式键盘 nudge —— 拖完一次后保留 source 的"selected" 状态，方向键继续微调
  const lastSelectedSourceRef = useRef(null);

  // Stable callback refs —— 防止 inline arrow props 每 render 新引用导致 useEffect re-mount，
  // re-mount 会重置 effect 内的 `local` state，正在 mousedown 中的拖动会瞬间失效。
  // 把 callbacks 放 ref，useEffect deps 只留 [active, zoom] 让 listeners 一次性挂稳。
  const onCommitMoveRef = useRef(onCommitMove);
  const onCommitFreePositionRef = useRef(onCommitFreePosition);
  const onCancelRef = useRef(onCancel);
  const onDraggingChangeRef = useRef(onDraggingChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onFreeModeChangeRef = useRef(onFreeModeChange);
  onCommitMoveRef.current = onCommitMove;
  onCommitFreePositionRef.current = onCommitFreePosition;
  onCancelRef.current = onCancel;
  onDraggingChangeRef.current = onDraggingChange;
  onSelectionChangeRef.current = onSelectionChange;
  onFreeModeChangeRef.current = onFreeModeChange;
  useEffect(() => {
    lastDropTargetRef.current = drag?.dropTarget || null;
    lastDropIntentRef.current = drag?.dropIntent || null;
    lastAlignRef.current = drag?.alignGuides || [];
    lastGhostRectRef.current = drag?.ghostRect || null;
  }, [drag]);
  // freeMode 从 prop 进，写回 ref 给 handle 闭包用（mousedown handler 注册一次即固定 closure）
  useEffect(() => { freeModeRef.current = freeMode; }, [freeMode]);
  // useEffect deps 注入 freeMode 让 handle 里的逻辑不需要重新 effect mount


  if (!active || !iframeRef?.current) return null;

  const iframe = iframeRef.current;
  const iframeRect = iframe.getBoundingClientRect();
  const base = overlayBase(iframe);
  if (!base) return null;

  // 把 iframe 内部坐标 (x, y, w, h) 转 overlay 坐标
  const toOverlay = (x, y, w, h) => ({
    top:  base.y + y * zoom,
    left: base.x + x * zoom,
    width:  w * zoom,
    height: h * zoom,
  });

  // Hover preview 已迁到 GrabHandle 组件（D 重构）—— DragOverlay 只画拖动 + landing flash

  if (!drag) {
    // 拖动结束后短暂 flash source 的新位置（确认换位成功）
    const flashOverlay = landingFlash ? (() => {
      const s = toOverlay(landingFlash.rect.left, landingFlash.rect.top, landingFlash.rect.width, landingFlash.rect.height);
      return (
        <div style={{
          position: 'absolute',
          pointerEvents: 'none',
          top: s.top - 4, left: s.left - 4,
          width: s.width + 8, height: s.height + 8,
          border: `3px solid ${CARET_COLOR}`,
          borderRadius: RADIUS.sm,
          background: alpha(EDITOR.blue, 0.12),
          boxShadow: '0 0 16px rgba(58,122,254, 0.5)',
          zIndex: 25,
          animation: 'nd-drag-landing-flash 350ms ease-out forwards',
        }} />
      );
    })() : null;
    return (
      <>
        {flashOverlay}
        {flashOverlay && (
          <style>{`
            @keyframes nd-drag-landing-flash {
              0%   { opacity: 1; transform: scale(1.02); }
              100% { opacity: 0; transform: scale(1); }
            }
          `}</style>
        )}
      </>
    );
  }

  const ghostStyle = toOverlay(drag.ghostRect.left, drag.ghostRect.top, drag.ghostRect.width, drag.ghostRect.height);
  const sourcePlaceholderStyle = toOverlay(drag.sourceRect.left, drag.sourceRect.top, drag.sourceRect.width, drag.sourceRect.height);

  // dropIntent 视觉派生：3 种 intent 决定不同视觉表现
  //   - sibling-before / sibling-after → 显示 caret + slot preview
  //   - child-of → 显示 hitChild 整框高亮 + "进入 X 内" 标签（不显 caret）
  const intent = drag.dropIntent?.intent;
  const isChildOf = intent === 'child-of';
  const sameContainer = drag.dropTarget && drag.source &&
    drag.dropIntent?.targetContainer === drag.source.parentElement;

  // sibling 模式才算 slot preview 几何（child-of 模式整框高亮代替）
  let slotPreviewStyle = null;
  if (!isChildOf && drag.dropIntent?.caretRect) {
    const cr = drag.dropIntent.caretRect;
    const srcW = drag.sourceRect.width;
    const srcH = drag.sourceRect.height;
    let sx, sy, sw, sh;
    if (cr.vertical) {
      sx = cr.x - srcW / 2; sy = cr.y; sw = srcW; sh = cr.h;
    } else {
      sx = cr.x; sy = cr.y - srcH / 2; sw = cr.w; sh = srcH;
    }
    slotPreviewStyle = toOverlay(sx, sy, sw, sh);
  }

  // child-of 时算 hitChild 整框 zone 几何（在 hitChild 中间画一个加深的 dashed 框 + 标签）
  let childOfZoneStyle = null;
  let childOfLabel = null;
  if (isChildOf && drag.dropIntent?.zoneRect) {
    const zr = drag.dropIntent.zoneRect;
    childOfZoneStyle = toOverlay(zr.x, zr.y, zr.w, zr.h);
    childOfLabel = drag.dropIntent.hitChild?.tagName?.toLowerCase?.() || 'container';
  }

  return (
    <>
      {/* 原位置 placeholder（dashed border 表示"东西要从这搬走"）
          同容器拖动时淡化，让用户注意力到 slot preview */}
      <div style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: sourcePlaceholderStyle.top,
        left: sourcePlaceholderStyle.left,
        width: sourcePlaceholderStyle.width,
        height: sourcePlaceholderStyle.height,
        border: `2px dashed rgba(43,33,23, ${sameContainer ? 0.18 : 0.3})`,
        borderRadius: RADIUS.sm,
        zIndex: 20,
        opacity: sameContainer ? 0.5 : 1,
      }} />

      {/* Ghost — 半透明跟手。自由模式（freeMode）换青绿色 + pin 图标提示 */}
      <div style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: ghostStyle.top,
        left: ghostStyle.left,
        width: ghostStyle.width,
        height: ghostStyle.height,
        background: drag.freeMode ? alpha(EDITOR.teal, 0.10) : alpha(EDITOR.blue, 0.08),
        border: `2px solid ${drag.freeMode ? EDITOR.teal : GHOST_COLOR}`,
        borderRadius: RADIUS.sm,
        boxShadow: drag.freeMode
          ? '0 8px 24px rgba(20, 184, 166, 0.30)'
          : '0 8px 24px rgba(43,33,23,0.18)',
        zIndex: 30,
        opacity: 0.92,
      }}>
        {drag.freeMode && (
          <div style={{
            position: 'absolute',
            top: -22, left: 0,
            padding: `${GAP.xxs}px ${GAP.md}px`,
            fontSize: FONT_SIZE.xs, lineHeight: '14px', fontWeight: 600,
            fontFamily: FONT_MONO,
            color: COLOR.bgWhite,
            background: EDITOR.teal,
            borderRadius: RADIUS.xs,
            whiteSpace: 'nowrap',
            boxShadow: SHADOW.crisp,
          }}>
            {drag.autoFree ? '📌 绝对定位元素 · 拖动改坐标，不动 DOM 结构' : '📌 自由模式 · 落到像素位置（再按 P 切回）'}
          </div>
        )}
        {!drag.freeMode && drag.reactMount && (
          <div style={{
            position: 'absolute',
            top: -22, left: 0,
            padding: `${GAP.xxs}px ${GAP.sm}px`,
            fontSize: FONT_SIZE.xs, lineHeight: '14px',
            fontFamily: FONT_MONO,
            color: COLOR.bgWhite,
            background: COLOR.warn,
            borderRadius: RADIUS.xs,
            whiteSpace: 'nowrap',
          }}>
            React 区 · 落地改 JSX
          </div>
        )}
        {drag.duplicate && (
          <div style={{
            position: 'absolute',
            top: -22, right: 0,
            padding: `${GAP.xxs}px ${GAP.md}px`,
            fontSize: FONT_SIZE.xs, lineHeight: '14px', fontWeight: 600,
            fontFamily: FONT_MONO,
            color: COLOR.bgWhite,
            background: EDITOR.violet,
            borderRadius: RADIUS.xs,
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 3px rgba(139,92,246,0.4)',
          }}>
            ⊕ 复制 (Alt-drag)
          </div>
        )}
        {!drag.freeMode && (
          <div style={{
            position: 'absolute',
            bottom: -20, right: 0,
            padding: `1px ${GAP.sm}px`,
            fontSize: FONT_SIZE.xxs, lineHeight: '14px',
            fontFamily: FONT_MONO,
            color: 'rgba(255,254,246,0.75)',
            background: 'rgba(43,33,23,0.7)',
            borderRadius: RADIUS.xs,
            whiteSpace: 'nowrap',
          }}>
            {drag.duplicate ? '松开 Alt 取消复制' : '按 P 切自由 · Alt 复制'}
          </div>
        )}
      </div>

      {/* 目标容器高亮 —— child-of 时强样式（用户要"进入"它）；sibling 同容器弱化；sibling 跨容器中等 */}
      {!drag.freeMode && drag.dropTarget && (() => {
        const r = drag.dropTarget.container.getBoundingClientRect();
        const s = toOverlay(r.left, r.top, r.width, r.height);
        const strong = isChildOf;
        return (
          <div style={{
            position: 'absolute',
            pointerEvents: 'none',
            top: s.top - 2, left: s.left - 2,
            width: s.width + 4, height: s.height + 4,
            border: sameContainer ? `1px dashed ${CARET_COLOR}` : `${strong ? 3 : 2}px solid ${CARET_COLOR}`,
            borderRadius: RADIUS.sm,
            background: sameContainer ? 'transparent' : `rgba(58,122,254, ${strong ? 0.10 : 0.04})`,
            zIndex: 18,
            opacity: sameContainer ? 0.45 : 1,
          }} />
        );
      })()}

      {/* child-of zone — 进入 hitChild 内部时整框加深 + "进入 <tag>" 标签 */}
      {!drag.freeMode && isChildOf && childOfZoneStyle && (
        <div style={{
          position: 'absolute',
          pointerEvents: 'none',
          top: childOfZoneStyle.top - 3,
          left: childOfZoneStyle.left - 3,
          width: childOfZoneStyle.width + 6,
          height: childOfZoneStyle.height + 6,
          border: `3px solid ${CARET_COLOR}`,
          background: alpha(EDITOR.blue, 0.14),
          borderRadius: 5,
          zIndex: 33,
        }}>
          <div style={{
            position: 'absolute',
            top: -24, left: '50%',
            transform: 'translateX(-50%)',
            padding: `3px ${GAP.base}px`,
            fontSize: FONT_SIZE.sm, lineHeight: '14px', fontWeight: 600,
            fontFamily: FONT_MONO,
            color: COLOR.bgWhite, background: CARET_COLOR,
            borderRadius: RADIUS.sm,
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 6px rgba(58,122,254, 0.4)',
          }}>
            进入 &lt;{childOfLabel}&gt; 内
          </div>
        </div>
      )}

      {/* Slot preview —— sibling intent 时显示，自由模式 / child-of 时不显 */}
      {!drag.freeMode && !isChildOf && slotPreviewStyle && (
        <div style={{
          position: 'absolute',
          pointerEvents: 'none',
          top: slotPreviewStyle.top,
          left: slotPreviewStyle.left,
          width: slotPreviewStyle.width,
          height: slotPreviewStyle.height,
          border: `2px dashed ${CARET_COLOR}`,
          background: alpha(EDITOR.blue, 0.10),
          borderRadius: RADIUS.xs,
          zIndex: 32,
        }}>
          {sameContainer && (
            <div style={{
              position: 'absolute',
              top: -22, left: '50%',
              transform: 'translateX(-50%)',
              padding: `${GAP.xxs}px ${GAP.md}px`,
              fontSize: FONT_SIZE.xs, lineHeight: '14px', fontWeight: 600,
              fontFamily: FONT_MONO,
              color: COLOR.bgWhite, background: CARET_COLOR,
              borderRadius: RADIUS.xs,
              whiteSpace: 'nowrap',
              boxShadow: SHADOW.crisp,
            }}>
              {intent === 'sibling-before' ? '插到此 sibling 之前' : '插到此 sibling 之后'}
            </div>
          )}
        </div>
      )}

      {/* Insertion caret —— sibling intent 时精确边界（child-of 时不显，整框已说明）*/}
      {!drag.freeMode && !isChildOf && drag.dropIntent?.caretRect && (() => {
        const r = drag.dropIntent.caretRect;
        const s = toOverlay(r.x, r.y, r.w, r.h);
        return (
          <div style={{
            position: 'absolute',
            pointerEvents: 'none',
            top: s.top, left: s.left,
            width: Math.max(s.width, 2), height: Math.max(s.height, 2),
            background: CARET_COLOR,
            boxShadow: `0 0 0 2px rgba(58,122,254, 0.25)`,
            borderRadius: 1,
            zIndex: 35,
          }} />
        );
      })()}

      {/* Alignment guides（贯穿可见区的虚线）*/}
      {drag.alignGuides && drag.alignGuides.map((g, i) => {
        if (g.axis === 'x') {
          const s = toOverlay(g.value, 0, 0, 9999);
          return (
            <div key={i} style={{
              position: 'absolute', pointerEvents: 'none',
              top: 0, left: s.left,
              width: 1, height: '100%',
              borderLeft: `1px dashed ${ALIGN_COLOR}`,
              zIndex: 28,
            }} />
          );
        }
        const s = toOverlay(0, g.value, 9999, 0);
        return (
          <div key={i} style={{
            position: 'absolute', pointerEvents: 'none',
            top: s.top, left: 0,
            width: '100%', height: 1,
            borderTop: `1px dashed ${ALIGN_COLOR}`,
            zIndex: 28,
          }} />
        );
      })}

      {/* Smart spacing hint —— ghost 跟两边邻居等距时的"等距 12px"绿色标签 */}
      {drag.smartSpacing && drag.smartSpacing.map((s, i) => {
        const isHoriz = s.side === 'horizontal';
        const labelX = isHoriz ? drag.ghostRect.left - 30 : drag.ghostRect.left + drag.ghostRect.width / 2 - 30;
        const labelY = isHoriz ? drag.ghostRect.top + drag.ghostRect.height / 2 - 8 : drag.ghostRect.top - 22;
        const pos = toOverlay(labelX, labelY, 60, 16);
        return (
          <div key={`spc-${i}`} style={{
            position: 'absolute', pointerEvents: 'none',
            top: pos.top, left: pos.left,
            width: pos.width, height: pos.height,
            background: EDITOR.green, color: COLOR.bgWhite,
            borderRadius: RADIUS.xs,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, lineHeight: '16px',
            textAlign: 'center', fontWeight: 600,
            boxShadow: '0 1px 3px rgba(22,163,74,0.3)',
            zIndex: 37,
          }}>
            等距 {s.gap}
          </div>
        );
      })}

      {/* Distance labels */}
      {drag.distanceLabels && drag.distanceLabels.map((d, i) => {
        const s = toOverlay(d.labelRect.x, d.labelRect.y, d.labelRect.w, d.labelRect.h);
        return (
          <div key={i} style={{
            position: 'absolute', pointerEvents: 'none',
            top: s.top, left: s.left,
            width: s.width, height: s.height,
            background: DISTANCE_BG, color: COLOR.bgWhite,
            borderRadius: 2,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, lineHeight: '16px',
            textAlign: 'center', fontWeight: 500,
            zIndex: 36,
          }}>
            {Math.round(d.gap)}
          </div>
        );
      })}
    </>
  );
}

/**
 * dwell delay 未到期时把 child-of 降级显示为 sibling-after —— 用户看到边缘 caret 而非
 * "进入"框，提示"再多停一会儿才会进入"。
 */
function downgradeToSiblingAfter(dropIntent) {
  if (!dropIntent || !dropIntent.hitChild) return dropIntent;
  const r = dropIntent.hitChild.getBoundingClientRect();
  const horizontal = dropIntent.horizontal;
  return {
    intent: 'sibling-after',
    targetContainer: dropIntent.hitChild.parentElement,
    beforeEl: dropIntent.hitChild.nextElementSibling || null,
    hitChild: dropIntent.hitChild,
    caretRect: horizontal
      ? { x: r.right - 1, y: r.top, w: 2, h: r.height, vertical: true }
      : { x: r.left, y: r.bottom - 1, w: r.width, h: 2, vertical: false },
    zoneRect: null,
    horizontal,
  };
}

function safeDoc(iframe) {
  try { return iframe?.contentDocument || iframe?.contentWindow?.document || null; }
  catch { return null; }
}

/** 把 parent document 的 clientX/Y 转到 iframe 内部 viewport 坐标系 */
function parentToIframeCoord(iframe, parentX, parentY, zoom) {
  if (!iframe) return { x: parentX, y: parentY };
  const r = iframe.getBoundingClientRect();
  const z = zoom || 1;
  const win = iframe.contentWindow;
  const scrollX = win?.scrollX || 0;
  const scrollY = win?.scrollY || 0;
  return {
    x: (parentX - r.left) / z + scrollX,
    y: (parentY - r.top)  / z + scrollY,
  };
}

/**
 * 从 mousedown 落点向上找一个"用户视觉上想拖的块状对象"。
 *
 * 启发式：
 *   - 节点必须是 block / flex / grid 显示（排掉 inline span / svg / text-leaf）
 *   - 节点不是 section[data-page]（slide 容器本身用户极少想整页拖；section 太大反而碍事）
 *     但允许拖 section 内的"第一层 block"
 *   - 节点 bounding rect 至少有 20x20 像素（排掉 inline icon 的退化 rect）
 *
 * 走到 body 还没找到 → null。
 */
export function pickDragSource(start, root) {
  let cur = start;
  while (cur && cur.nodeType === 1 && cur !== root) {
    if (cur === root.ownerDocument.documentElement) return null;
    const view = cur.ownerDocument.defaultView;
    if (!view) return null;
    const cs = view.getComputedStyle(cur);
    const display = cs.display;
    const r = cur.getBoundingClientRect();
    const isBlocky = display && (
      display === 'block' || display === 'flex' || display === 'grid' ||
      display === 'inline-block' || display === 'inline-flex' || display === 'inline-grid' ||
      display === 'list-item' || display === 'table' || display === 'table-cell'
    );
    const sizable = r.width >= 20 && r.height >= 20;
    // section[data-page] 整页太大不拖 — 跳过让上层（body）也不命中 → null
    if (cur.tagName === 'SECTION' && cur.hasAttribute('data-page')) {
      return null;
    }
    if (isBlocky && sizable) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function alignHintLabel(g) {
  const hints = {
    'edge-left':   '左对齐',
    'edge-right':  '右对齐',
    'center-x':    '水平居中',
    'edge-top':    '顶部对齐',
    'edge-bottom': '底部对齐',
    'center-y':    '垂直居中',
  };
  const name = g.neighbor?.tagName?.toLowerCase?.() || '邻居';
  return `${hints[g.hint] || g.hint}（与 ${name}）`;
}
