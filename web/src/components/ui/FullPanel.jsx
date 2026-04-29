import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { PANEL, COLOR, GAP } from "../../lib/theme.js";

/**
 * Container Transform 动画壳 — 从 originRect 展开到近全屏
 * 使用 top/left/width/height 动画（非 scale），确保内容正常渲染
 */
export default function FullPanel({ show, onClose, originRect, actions, children }) {
  const [phase, setPhase] = useState("hidden");

  useEffect(() => {
    if (show && phase === "hidden") {
      setPhase("entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPhase("visible"));
      });
    } else if (!show && (phase === "visible" || phase === "entering")) {
      setPhase("exiting");
      const t = setTimeout(() => setPhase("hidden"), 500);
      return () => clearTimeout(t);
    }
  }, [show]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  if (phase === "hidden") return null;

  const isExpanded = phase === "visible";
  const or = originRect || {
    top: window.innerHeight / 2 - 100,
    left: window.innerWidth / 2 - 180,
    width: 360, height: 200,
  };

  const margin = 40;
  const target = {
    top: margin, left: margin,
    width: window.innerWidth - margin * 2,
    height: window.innerHeight - margin * 2,
  };

  // 收起状态用 origin rect，展开状态用 target rect
  const rect = isExpanded ? target : or;

  return (
    <>
      {/* 背景遮罩 */}
      <div onClick={handleClose} style={{
        position: "fixed", inset: 0, zIndex: PANEL.zIndex - 1,
        background: PANEL.overlay,
        opacity: isExpanded ? 1 : 0,
        transition: "opacity 0.4s ease",
        pointerEvents: isExpanded ? "auto" : "none",
      }} />

      {/* 主面板 — 直接动画位置和尺寸 */}
      <div style={{
        position: "fixed",
        top: rect.top, left: rect.left,
        width: rect.width, height: rect.height,
        zIndex: PANEL.zIndex,
        background: COLOR.gradModal,
        borderRadius: isExpanded ? 16 : PANEL.radius,
        boxShadow: isExpanded
          ? "0 4px 8px rgba(0,0,0,0.04), 0 16px 32px rgba(0,0,0,0.1), 0 32px 64px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.8)"
          : "0 2px 8px rgba(0,0,0,0.1)",
        border: "1px solid rgba(0,0,0,0.1)",
        overflow: "hidden",
        transition: PANEL.transition,
      }}>
        {/* 可滚动内容区 */}
        <div style={{
          width: "100%", height: "100%",
          overflow: "auto",
          opacity: isExpanded ? 1 : 0,
          transition: "opacity 0.3s ease 0.2s",
        }}>
          {/* 顶栏：操作按钮 + 关闭 */}
          <div style={{
            position: "sticky", top: 0, zIndex: 10,
            display: "flex", alignItems: "center", justifyContent: "flex-end", gap: GAP.md,
            padding: `${GAP.lg}px ${GAP.xl}px 0`,
            background: "linear-gradient(180deg, rgba(253,252,250,0.95) 0%, rgba(253,252,250,0) 100%)",
          }}>
            {actions}
            <div onClick={handleClose} style={{
              width: 32, height: 32, borderRadius: GAP.md,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer",
              background: "rgba(0,0,0,0.04)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              transition: "background 0.15s",
            }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.08)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.04)"}
            >
              <X size={16} color={COLOR.text5} strokeWidth={1.5} />
            </div>
          </div>

          {/* 子内容 */}
          <div style={{ padding: "0 24px 24px" }}>
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
