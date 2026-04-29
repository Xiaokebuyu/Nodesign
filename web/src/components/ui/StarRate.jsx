import { Star } from "lucide-react";
import { COLOR } from "../../lib/theme.js";

export default function StarRate({ value, max, onChange }) {
  return (<div style={{ display: "flex", gap: 2 }}>{Array.from({ length: max }, (_, i) => (
    <span key={i} onClick={() => onChange(i + 1)} style={{ cursor: "pointer", transition: "color 0.15s", color: i < value ? COLOR.gold : COLOR.borderMd }}><Star size={16} fill={i < value ? COLOR.gold : "none"} /></span>
  ))}</div>);
}
