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

  // 受控 vs 非受控
  const controlled = !!state;
  const visible = controlled ? state.visible : true;
  if (!visible) return null;

  // 受控时：position / size 从 manager 拿（fallback default*）
  // 非受控时：用 default*，Rnd 自管
  const position = controlled && state.position ? state.position : defaultPosition;
  const size = controlled && state.size ? state.size : defaultSize;
  const zIndex = controlled ? state.zIndex : 100;

  const handleDragStop = (_e, d) => {
    if (controlled) state.setPosition({ x: d.x, y: d.y });
  };

  const handleResizeStop = (_e, _direction, ref, _delta, pos) => {
    if (controlled) {
      state.setSize({ width: ref.offsetWidth, height: ref.offsetHeight });
      state.setPosition({ x: pos.x, y: pos.y });
    }
  };

  const handleMouseDown = () => {
    if (controlled) state.bringToFront();
  };

  return (
    <Rnd
      // 受控模式：position/size 走 props（manager state）
      // 非受控模式：default 走 props（Rnd 自管）
      {...(controlled
        ? { position, size, onDragStop: handleDragStop, onResizeStop: handleResizeStop }
        : { default: { ...defaultPosition, ...defaultSize } }
      )}
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
        boxShadow: STAGE.shadow,
        border: `1px solid ${STAGE.borderWarm}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
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
        {onClose && (
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
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
