import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { FONT_MONO, FONT_SANS, COLOR, GAP, FONT_SIZE } from "../../lib/theme.js";

/** 数据指标小卡片 — 可复用 */
export default function DataCard({ label, value, trend, warn }) {
  return (
    <div style={{
      flex: 1, minWidth: 60, borderRadius: GAP.md, padding: `${GAP.md}px ${GAP.base}px`,
      background: warn ? "rgba(184,58,42,0.06)" : "rgba(0,0,0,0.03)",
    }}>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: GAP.xs }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xl, color: warn ? COLOR.error : COLOR.text, fontWeight: 500 }}>{value}</span>
        {trend === "up" && <TrendingUp size={12} color={COLOR.success} />}
        {trend === "down" && <TrendingDown size={12} color={COLOR.error} />}
        {trend === "flat" && <Minus size={12} color={COLOR.sub} />}
      </div>
    </div>
  );
}
