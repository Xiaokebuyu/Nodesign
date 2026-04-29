import { FONT_MONO, FONT_SANS, MODAL, COLOR, GAP, FONT_SIZE } from "../../lib/theme.js";

export function FormModal({ title, show, onClose, children }) {
  return (<div onClick={onClose} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: MODAL.overlay, zIndex: MODAL.zIndex, display: "flex", alignItems: "center", justifyContent: "center", opacity: show ? 1 : 0, pointerEvents: show ? "auto" : "none", transition: "opacity 0.3s", backdropFilter: MODAL.blur }}>
    <div onClick={e => e.stopPropagation()} style={{ width: 360, maxHeight: "85vh", overflowY: "auto", background: COLOR.bgWhite, border: `1px solid ${COLOR.borderMd}`, borderRadius: MODAL.radius, boxShadow: MODAL.shadow, transform: show ? MODAL.scaleVisible : MODAL.scaleHidden, transition: MODAL.transition }}>
      <div style={{ padding: `${FONT_SIZE.lg}px ${GAP.xl}px ${GAP.base}px`, borderBottom: `1px solid ${COLOR.border}`, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xl, color: COLOR.text }}>{title}</div>
      <div style={{ padding: `${GAP.lg}px ${GAP.xl}px` }}>{children}</div>
    </div>
  </div>);
}

export function FInput({ label, value, onChange, placeholder, multiline, type = "text" }) {
  const s = { width: "100%", padding: `${GAP.md}px ${GAP.base}px`, background: "rgba(255,255,255,0.4)", border: `1px solid ${COLOR.border}`, borderRadius: GAP.md, fontFamily: FONT_SANS, fontSize: FONT_SIZE.h2, color: COLOR.text, outline: "none", boxSizing: "border-box", resize: "vertical" };
  return (<div style={{ marginBottom: GAP.lg }}><div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xl, color: COLOR.text3, marginBottom: GAP.xs }}>{label}</div>{multiline ? <textarea value={value} onChange={onChange} placeholder={placeholder} rows={3} style={s} /> : <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={s} />}</div>);
}

export function FSelect({ label, value, onChange, options }) {
  return (<div style={{ marginBottom: GAP.lg }}><div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xl, color: COLOR.text3, marginBottom: GAP.xs }}>{label}</div><div style={{ display: "flex", gap: GAP.sm }}>{options.map(o => (<button key={o.v} onClick={() => onChange(o.v)} style={{ padding: `5px ${GAP.base}px`, borderRadius: GAP.sm, cursor: "pointer", background: value === o.v ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.3)", border: value === o.v ? `2px solid ${COLOR.borderHv}` : `1px solid ${COLOR.border}`, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xl, color: o.c || COLOR.text }}>{o.l}</button>))}</div></div>);
}

export function FBtn({ label, onClick, full }) {
  return (<button onClick={onClick} style={{ padding: `${GAP.md}px ${GAP.xl}px`, borderRadius: GAP.md, cursor: "pointer", background: "rgba(0,0,0,0.08)", border: `1px solid ${COLOR.border}`, fontFamily: FONT_SANS, fontSize: FONT_SIZE.h2, color: COLOR.text, width: full ? "100%" : "auto" }}>{label}</button>);
}
