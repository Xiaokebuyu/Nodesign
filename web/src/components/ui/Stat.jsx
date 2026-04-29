import { FONT_MONO, COLOR, GAP, FONT_SIZE } from "../../lib/theme.js";

export default function Stat({ label, value, color }) {
  return (
    <div style={{ background: COLOR.bgWhite, borderRadius: GAP.lg, padding: `${GAP.base}px 14px`, border: `1px solid ${COLOR.border}`, textAlign: "center", flex: 1, boxShadow: `0 1px 3px ${COLOR.borderLt}` }}>
      <div style={{ fontSize: FONT_SIZE.sm, color: COLOR.sub, letterSpacing: 0.5, marginBottom: GAP.xs }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 24, color, lineHeight: 1 }}>{value}</div>
    </div>
  );
}
