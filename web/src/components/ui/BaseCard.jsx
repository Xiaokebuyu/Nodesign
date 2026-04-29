import { CARD } from "../../lib/theme.js";

export default function BaseCard({ style, hovered, onHover, onLeave, onClick, absolute = true, children }) {
  return (
    <div onMouseEnter={onHover} onMouseLeave={onLeave} onClick={onClick}
      style={{
        position: absolute ? "absolute" : "relative",
        width: CARD.w, height: CARD.h,
        background: hovered ? CARD.bgHover : CARD.bg,
        border: hovered ? CARD.borderHover : CARD.border,
        borderRadius: CARD.radius, cursor: "pointer",
        boxShadow: hovered ? CARD.shadowHover : CARD.shadow,
        transition: CARD.transition,
        transformOrigin: "bottom center", overflow: "hidden",
        ...(absolute ? style : { transform: hovered ? `translateY(${CARD.hoverY}px) scale(${CARD.hoverScale})` : "none", ...style }),
      }}>
      <div style={{ padding: CARD.padding }}>
        {children}
      </div>
    </div>
  );
}
