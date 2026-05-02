import { useState } from 'react';
import { Rnd } from 'react-rnd';
import { X } from 'lucide-react';
import { COLOR, FONT_MONO, FONT_SIZE, GAP, STAGE } from '../../lib/theme.js';
import { usePanelState } from './PanelManager.jsx';

/**
 * FloatingPanel — macOS 多窗口浮动 panel 风的统一卡片壳
 *
 * Canvas 焕新升级 F1.1（视觉壳） + F1.2（受控 + PanelManager 集成）。
 *
 * 视觉对齐 stage 风（STAGE token）：
 *   - 圆角 12px / 暖白底 / STAGE.shadow 双层柔光 / STAGE.borderWarm 暖棕薄边
 *   - title bar 半透明白 + 暖棕底边，整条是拖拽 handle
 *   - icon 用 lucide / title 用 FONT_MONO 小字
 *   - close button 在右侧（可 onClose 不传则不显）
 *
 * 受控 / 非受控：
 *   - 如果 id 在 <PanelManagerProvider> 注册的 defaultPanels 中存在 → 受控
 *     （position / size / visible / zIndex 走 PanelManager state；
 *     拖拽 / resize / 点击置顶自动 emit 给 manager；不在则不渲染）
 *   - 否则 → fallback 到 default* props（独立浮窗，不持久化）
 *
 * 拖拽 / resize：
 *   - dragHandleClassName='fp-drag-handle' 限制只 title bar 可拖（防 panel
 *     内部交互 element 被误拖）
 *   - bounds='window' 防越界
 *   - resize 默认开右下角 + 右边 + 下边（其他方向关）
 *   - mousedown panel 任何位置 → bringToFront（z-index 升到最前）
 *
 * Props：
 *   - id: string                    panel 唯一 id（PanelManager 用）
 *   - title: string                 标题
 *   - icon: lucide component        （可选）
 *   - defaultPosition: {x, y}       fallback（PanelManager 没注册时用）
 *   - defaultSize: {width, height}  fallback
 *   - minWidth, minHeight: number   resize 下限
 *   - onClose: () => void           close 按钮回调（不传则不显 close）
 *   - children: ReactNode
 *   - bodyStyle: object             可覆盖 body 容器 style
 */
export default function FloatingPanel({
  id,
  title,
  icon: Icon,
  defaultPosition = { x: 50, y: 50 },
  defaultSize = { width: 360, height: 400 },
  minWidth = 200,
  minHeight = 120,
  onClose,
  children,
  bodyStyle,
}) {
  const state = usePanelState(id);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  // 受控 vs 非受控
  const controlled = !!state;
  const visible = controlled ? state.visible : true;
  if (!visible) return null;

  // 受控时：position / size 从 manager 拿（fallback default*）
  // 非受控时：用 default*，Rnd 自管
  const position = controlled && state.position ? state.position : defaultPosition;
  const size = controlled && state.size ? state.size : defaultSize;
  const zIndex = controlled ? state.zIndex : 100;

  const handleDragStart = () => setDragging(true);
  const handleDragStop = (_e, d) => {
    setDragging(false);
    if (!controlled) return;

    // F3.1：拖到边缘自动 snap（macOS / Aero Snap 风）
    const W = window.innerWidth;
    const H = window.innerHeight;
    const SNAP_THRESHOLD = 40;            // 拖到边缘 40px 以内触发 snap
    const TOP_OFFSET = 60;                // 留 TopBar 空间
    const PAD = 8;
    const usableH = H - TOP_OFFSET - PAD;

    // 顶部 → max（全屏，不含 TopBar）
    if (d.y < TOP_OFFSET) {
      state.setPosition({ x: PAD, y: TOP_OFFSET });
      state.setSize({ width: W - PAD * 2, height: usableH });
      return;
    }
    // 左边缘 → 左半屏
    if (d.x < SNAP_THRESHOLD) {
      state.setPosition({ x: PAD, y: TOP_OFFSET });
      state.setSize({ width: Math.floor(W / 2) - PAD * 2, height: usableH });
      return;
    }
    // 右边缘 → 右半屏（panel 自身宽度也算，X + width 接近 W）
    const panelWidth = (controlled && state.size?.width) || defaultSize.width;
    if (d.x + panelWidth > W - SNAP_THRESHOLD) {
      const halfW = Math.floor(W / 2) - PAD * 2;
      state.setPosition({ x: Math.floor(W / 2) + PAD, y: TOP_OFFSET });
      state.setSize({ width: halfW, height: usableH });
      return;
    }
    // 自由位置
    state.setPosition({ x: d.x, y: d.y });
  };

  const handleResizeStart = () => setResizing(true);
  const handleResizeStop = (_e, _direction, ref, _delta, pos) => {
    setResizing(false);
    if (controlled) {
      state.setSize({ width: ref.offsetWidth, height: ref.offsetHeight });
      state.setPosition({ x: pos.x, y: pos.y });
    }
  };

  const handleMouseDown = () => {
    if (controlled) state.bringToFront();
  };

  // F3.1：拖拽 / resize 时 panel 半透明 + shadow 加深（macOS 拖窗口同款感）
  const interacting = dragging || resizing;

  // 受控模式下没传 onClose → 默认 X = setVisible(false)
  // 非受控模式没传 onClose → X 不显示
  const effectiveOnClose = onClose || (controlled ? () => state.setVisible(false) : null);

  return (
    <Rnd
      // 受控模式：position/size 走 props（manager state）
      // 非受控模式：default 走 props（Rnd 自管）
      {...(controlled
        ? { position, size, onDragStop: handleDragStop, onResizeStop: handleResizeStop }
        : { default: { ...defaultPosition, ...defaultSize } }
      )}
      onDragStart={handleDragStart}
      onResizeStart={handleResizeStart}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="window"
      dragHandleClassName="fp-drag-handle"
      enableResizing={{
        top: false, left: false,
        right: true, bottom: true, bottomRight: true,
        topRight: false, topLeft: false, bottomLeft: false,
      }}
      onMouseDown={handleMouseDown}
      style={{
        zIndex,
        background: '#fff',
        borderRadius: STAGE.radius,
        boxShadow: interacting
          ? '0 16px 48px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)'
          : STAGE.shadow,
        border: `1px solid ${STAGE.borderWarm}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        opacity: interacting ? 0.92 : 1,
        transition: 'opacity 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      {/* Title bar */}
      <div
        className="fp-drag-handle"
        style={{
          cursor: 'move',
          display: 'flex',
          alignItems: 'center',
          gap: GAP.sm,
          padding: `${GAP.md}px ${GAP.lg}px`,
          background: 'rgba(255,255,255,0.95)',
          borderBottom: `1px solid ${STAGE.borderWarm}`,
          fontFamily: FONT_MONO,
          fontSize: FONT_SIZE.xs,
          fontWeight: 500,
          color: COLOR.text,
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        {Icon && <Icon size={12} style={{ color: COLOR.text4 }} />}
        <span style={{ flex: 1 }}>{title}</span>
        {effectiveOnClose && (
          <button
            onClick={(e) => { e.stopPropagation(); effectiveOnClose(); }}
            onMouseDown={(e) => e.stopPropagation()}
            title="关闭"
            style={{
              width: 20, height: 20,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: 'transparent',
              borderRadius: 4,
              color: COLOR.text5,
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0,0,0,0.06)';
              e.currentTarget.style.color = COLOR.text;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = COLOR.text5;
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        ...bodyStyle,
      }}>
        {children}
      </div>
    </Rnd>
  );
}
