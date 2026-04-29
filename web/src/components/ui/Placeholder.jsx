import { FONT_MONO, FONT_SANS } from "../../lib/theme.js";

export default function Placeholder({ title }) {
  return (
    <div style={{ margin: "20px auto", maxWidth: 500, textAlign: "center", padding: "50px 20px", background: "#f5f3f0", borderRadius: 14, border: "1px solid rgba(0,0,0,0.06)", boxShadow: "0 4px 16px rgba(0,0,0,0.1)" }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 15, color: "#5a5550", marginBottom: 8 }}>{title}</div>
      <div style={{ fontFamily: FONT_SANS, fontSize: 18, color: "#9a8a68" }}>施工中...</div>
    </div>
  );
}
