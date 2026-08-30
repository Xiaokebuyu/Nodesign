import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Rnd } from 'react-rnd';
import { X } from 'lucide-react';
import { COLOR, FONT_SANS, FONT_MONO, FONT_SIZE, GAP, RADIUS, STAGE, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { usePanelState } from './PanelManager.jsx';

/**
 * FloatingPanel — macOS 多窗口浮动 panel 风的统一卡片壳
 *
 * Canvas 焕新升级 F1.1（视觉壳） + F1.2（受控） + F3.1（拖拽透明度 + edge
 * snap） + F3.1+（snap visual preview，2026-05-02 用户要求）。
 *
 * 视觉对齐 stage 风（STAGE token）：
 *   - 圆角 12px / 暖白底 / STAGE.shadow 双层柔光 / STAGE.borderWarm 暖棕薄边
 *   - title bar 半透明白 + 暖棕底边，整条是拖拽 handle
 *   - icon 用 lucide / title 用 FONT_MONO 小字
 *   - close button 在右侧（可 onClose 不传则不显）
 *
 * 受控 / 非受控：
 *   - 如果 id 在 <PanelManagerProvider> 注册的 defaultPanels 中存在 → 受控
 *   - 否则 → fallback 到 default* props（独立浮窗，不持久化）
 *
 * Snap-to-edge（macOS / Aero Snap 风）：
 *   - 拖拽中实时检测鼠标位置，触发 snap zone 时显示蓝色半透明 overlay 预览
 *   - 释放鼠标时 snap 到对应位置 + size
 *   - 三种 snap 模式：top（max 全屏）/ left（左半屏）/ right（右半屏）
 *
 * 拖拽 / resize：
 *   - dragHandleClassName='fp-drag-handle' 限制只 title bar 可拖
 *   - bounds='window' 防越界
 *   - resize 默认开右下角 + 右边 + 下边
 *   - mousedown panel 任何位置 → bringToFront
 */

const SNAP_THRESHOLD = 50;
const TOP_OFFSET = 60;
const SNAP_PAD = 8;

/**
 * 根据当前拖拽位置算 snap target + 预览矩形
 * 返 { target: 'top'|'left'|'right'|null, zone: {x,y,w,h} }
 */
function computeSnapTarget(x, y, panelW, W, H) {
  const usableH = H - TOP_OFFSET - SNAP_PAD;
  // 顶部 → max
  if (y < TOP_OFFSET) {
    return {
      target: 'top',
      zone: { x: SNAP_PAD, y: TOP_OFFSET, w: W - SNAP_PAD * 2, h: usableH },
    };
  }
  // 左边缘 → 左半屏
  if (x < SNAP_THRESHOLD) {
    return {
      target: 'left',
      zone: { x: SNAP_PAD, y: TOP_OFFSET, w: Math.floor(W / 2) - SNAP_PAD * 2, h: usableH },
    };
  }
  // 右边缘 → 右半屏
  if (x + panelW > W - SNAP_THRESHOLD) {
    const halfW = Math.floor(W / 2) - SNAP_PAD * 2;
    return {
      target: 'right',
      zone: { x: Math.floor(W / 2) + SNAP_PAD, y: TOP_OFFSET, w: halfW, h: usableH },
    };
  }
  return { target: null, zone: null };
}

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
  // Drag bounds：传 'window' / 'parent' / selector / HTMLElement。
  // 默认 'parent' —— 浮窗只在父容器内拖（典型场景：浮在 canvas 上不出 canvas）。
  // snap-to-edge 仅 bounds==='window' 时启用（小区域内 snap 没意义）。
  bounds = 'parent',
  /**
   * 能不能关。**默认能，但主界面必须传 false**。
   *
   * 受控 panel 原本一律带关闭钮（`effectiveOnClose` 在 controlled 时自动兜底），
   * 而 PanelMenu 那个"面板"菜单 2026 年已下架 —— 也就是说**关掉的浮窗没有任何
   * UI 能叫回来**，只能清 localStorage。次级面板（Tweaks）关了无所谓，聊天栏
   * 关了就等于把主界面弄丢了。所以这个开关是必需的，不是可选的礼貌。
   */
  closable = true,
  /** 标题栏右侧塞自定义控件（收起钮之类），排在关闭钮左边 */
  titleExtra,
}) {
  const state = usePanelState(id);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [snap, setSnap] = useState(null);  // { target, zone } | null

  const controlled = !!state;
  const visible = controlled ? state.visible : true;
  if (!visible) return null;

  const position = controlled && state.position ? state.position : defaultPosition;
  const size = controlled && state.size ? state.size : defaultSize;
  const zIndex = controlled ? state.zIndex : 100;

  const panelWidth = size?.width || defaultSize.width;
  const snapEnabled = bounds === 'window';

  const handleDragStart = () => {
    setDragging(true);
    setSnap(null);
  };

  const handleDrag = (_e, d) => {
    if (!snapEnabled) return;
    // 拖拽中实时检测 snap target，更新预览 overlay
    const W = window.innerWidth;
    const H = window.innerHeight;
    const next = computeSnapTarget(d.x, d.y, panelWidth, W, H);
    // 优化：只在 target 变化时 setState（避免每 px 重渲染）
    setSnap(prev => {
      if (prev?.target === next.target) return prev;
      return next.target ? next : null;
    });
  };

  const handleDragStop = (_e, d) => {
    setDragging(false);
    if (!controlled) return;

    // 如果有 snap target，按预览 zone snap
    if (snap?.target) {
      state.setPosition({ x: snap.zone.x, y: snap.zone.y });
      state.setSize({ width: snap.zone.w, height: snap.zone.h });
      setSnap(null);
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

  const interacting = dragging || resizing;
  const effectiveOnClose = closable
    ? (onClose || (controlled ? () => state.setVisible(false) : null))
    : null;

  return (
    <>
      {/* Snap 预览 overlay —— 拖拽中触发到 snap zone 时显示半透明蓝色矩形 */}
      {snap?.zone && createPortal(
        <div
          style={{
            position: 'fixed',
            left: snap.zone.x,
            top: snap.zone.y,
            width: snap.zone.w,
            height: snap.zone.h,
            background: alpha(COLOR.blue, 0.18),
            border: '2px solid rgba(90, 122, 154, 0.55)',
            borderRadius: STAGE.radius,
            pointerEvents: 'none',
            zIndex: 9998,
            transition: 'all 0.12s ease',
          }}
        />,
        document.body,
      )}

      <Rnd
        {...(controlled
          ? { position, size, onDragStop: handleDragStop, onResizeStop: handleResizeStop }
          : { default: { ...defaultPosition, ...defaultSize } }
        )}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onResizeStart={handleResizeStart}
        minWidth={minWidth}
        minHeight={minHeight}
        bounds={bounds}
        dragHandleClassName="fp-drag-handle"
        enableResizing={{
          top: false, left: false,
          right: true, bottom: true, bottomRight: true,
          topRight: false, topLeft: false, bottomLeft: false,
        }}
        onMouseDown={handleMouseDown}
        style={{
          zIndex,
          // 纸，不是浮层（2026-08-07）：浮窗浮在画布上，而画布上别的东西
          // （便签、产物卡、文件夹）全是纸。原来这里是纯白 + 圆角 12 + 中性
          // 柔光，压在纸面上就是两种材质打架 —— 它看起来像贴上去的对话框，
          // 而不是桌上另一张纸。
          //   · 底色换 PAPER.paper 并铺同一层颗粒
          //   · 圆角归零（这套语言里最大的实体是纸，纸没有圆角）
          //   · 影子换 PAPER_SHADOW（单一光向：右上打光，影子偏左下）
          background: PAPER.paper,
          backgroundImage: GRAIN,
          borderRadius: 0,
          boxShadow: interacting ? PAPER_SHADOW.near : PAPER_SHADOW.mid,
          border: `1px solid ${PAPER.hair}`,
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
            // 标题条 = 纸的抬头：比纸身略深一点点的暖色，不是白条
            background: alpha(PAPER.wall, 0.55),
            borderBottom: `1px solid ${PAPER.hair}`,
            fontFamily: FONT_SANS,
            fontSize: FONT_SIZE.xs,
            fontWeight: 500,
            color: COLOR.text,
            userSelect: 'none',
            flexShrink: 0,
          }}
        >
          {Icon && <Icon size={12} style={{ color: COLOR.text4 }} />}
          <span style={{ flex: 1 }}>{title}</span>
          {titleExtra}
          {effectiveOnClose && (
            <button
              onClick={(e) => { e.stopPropagation(); effectiveOnClose(); }}
              onMouseDown={(e) => e.stopPropagation()}
              title="关闭"
              style={{
                width: 20, height: 20,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', background: 'transparent',
                borderRadius: RADIUS.sm,
                color: COLOR.text5,
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(43,33,23,0.06)';
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
    </>
  );
}
