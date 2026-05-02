import { Rnd } from 'react-rnd';
import { X } from 'lucide-react';
import { COLOR, FONT_MONO, FONT_SIZE, GAP, STAGE } from '../../lib/theme.js';

/**
 * FloatingPanel — macOS 多窗口浮动 panel 风的统一卡片壳
 *
 * Canvas 焕新升级 F1.1（2026-05-02）。
 *
 * 用户语境：每个功能模块（Chat / Canvas / Inspect / Comments / Decisions /
 * Tweaks / System）都是一个独立浮动小窗，自带 title bar + close button，可拖
 * 可 resize，浮在 stage 暖底之上。
 *
 * 视觉对齐 stage 风（STAGE token）：
 *   - 圆角 12px / 暖白底 / STAGE.shadow 双层柔光 / STAGE.borderWarm 暖棕薄边
 *   - title bar 半透明白 + 暖棕底边，整条是拖拽 handle
 *   - icon 用 lucide / title 用 FONT_MONO 小字
 *   - close button 在右侧（可 onClose 不传则不显）
 *
 * 拖拽 / resize：
 *   - dragHandleClassName='fp-drag-handle' 限制只 title bar 可拖（防 panel
 *     内部交互 element 被误拖）
 *   - bounds='window' 防越界
 *   - default minWidth / minHeight 200×120
 *   - resize 默认开右下角 + 右边 + 下边（其他方向关，避免 title bar 被 hover
 *     成 resize cursor）
 *
 * Props：
 *   - id: string                    panel 唯一 id（PanelManager 用）
 *   - title: string                 标题文字
 *   - icon: React component         lucide icon component（可选）
 *   - defaultPosition: {x, y}       初始位置（默认 50, 50）
 *   - defaultSize: {width, height}  初始大小（默认 360x400）
 *   - minWidth: number              （默认 200）
 *   - minHeight: number             （默认 120）
 *   - onClose: () => void           close 按钮回调（不传则不显 close）
 *   - zIndex: number                z-index（PanelManager 管理 focus）
 *   - children: ReactNode           panel 内容
 *   - bodyStyle: object             panel body 自定义 style 覆盖（可选）
 *
 * 不在本组件管理：
 *   - position / size 受控（state 提到 PanelManager，本组件只受 default*）
 *   - 拖拽 / resize 事件回调（同上，F1.2 PanelManager 接手时传 onDragStop /
 *     onResizeStop）
 *   - 关闭后的 visible state（PanelManager 管）
 *
 * F1.1 仅做"无状态视觉壳"。F1.2 PanelManager 加 controlled position/size +
 * 持久化 + Context。
 */
export default function FloatingPanel({
  // eslint-disable-next-line no-unused-vars
  id,
  title,
  icon: Icon,
  defaultPosition = { x: 50, y: 50 },
  defaultSize = { width: 360, height: 400 },
  minWidth = 200,
  minHeight = 120,
  onClose,
  zIndex = 100,
  children,
  bodyStyle,
}) {
  return (
    <Rnd
      default={{ ...defaultPosition, ...defaultSize }}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="window"
      dragHandleClassName="fp-drag-handle"
      enableResizing={{
        top: false, left: false,
        right: true, bottom: true, bottomRight: true,
        topRight: false, topLeft: false, bottomLeft: false,
      }}
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
      {/* Title bar — 整条 drag handle */}
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
            onMouseDown={(e) => e.stopPropagation()}  // 防 close click 被 Rnd 当 drag
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

      {/* Body —— 滚动溢出由内容自己处理（默认 overflow auto） */}
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
