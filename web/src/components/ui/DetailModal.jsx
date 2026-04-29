import { MODAL, COLOR } from "../../lib/theme.js";

/**
 * 详情弹窗 — 支持 originRect 实现 Container Transform 效果
 * 当传入 originRect 时，从卡片位置展开；否则从屏幕中央缩放
 */
export default function DetailModal({ show, onClose, width, originRect, children }) {
  const w = width || MODAL.width;

  // 目标位置：屏幕居中
  const targetLeft = (typeof window !== "undefined" ? window.innerWidth : 800) / 2 - w / 2;
  const targetTop = (typeof window !== "undefined" ? window.innerHeight : 600) * 0.15;

  return (
    <div onClick={onClose} style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: MODAL.overlay, zIndex: MODAL.zIndex,
      display: "flex", alignItems: "center", justifyContent: "center",
      opacity: show ? 1 : 0, pointerEvents: show ? "auto" : "none",
      transition: "opacity 0.3s",
      backdropFilter: MODAL.blur,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: w, maxHeight: "80vh",
        background: COLOR.gradModal,
        border: "1px solid rgba(0,0,0,0.1)",
        borderRadius: MODAL.radius,
        // 多层 box-shadow 增加深度
        boxShadow: [
          "0 2px 4px rgba(0,0,0,0.04)",
          "0 8px 20px rgba(0,0,0,0.08)",
          "0 24px 48px rgba(0,0,0,0.12)",
          "inset 0 1px 0 rgba(255,255,255,0.8)",
        ].join(", "),
        overflow: "auto",
        transform: show ? "scale(1) translateY(0)" : "scale(0.88) translateY(24px)",
        transition: "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.4s ease",
      }}>
        {children}
      </div>
    </div>
  );
}
