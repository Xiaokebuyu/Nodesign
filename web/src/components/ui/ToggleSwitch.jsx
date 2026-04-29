import { FONT_SANS, COLOR, FONT_SIZE } from "../../lib/theme.js";

/**
 * 药丸形滑动切换开关 — 支持 2~N 个选项，宽度自适应
 * @param {{ options: {id:string, label:string}[], value: string, onChange: (id:string)=>void, width?: number }} props
 */
export default function ToggleSwitch({ options, value, onChange, width }) {
  const activeIdx = options.findIndex(o => o.id === value);
  const totalW = width || Math.max(200, options.length * 80);
  const innerW = totalW - 6; // 减去左右 padding 各 3px
  const slotW = innerW / options.length;

  return (
    <div style={{
      position: "relative", display: "inline-flex", alignItems: "center",
      width: totalW, height: 34, borderRadius: 17,
      background: COLOR.border, padding: 3, userSelect: "none",
    }}>
      {/* 滑动高亮条 */}
      <div style={{
        position: "absolute", top: 3, bottom: 3,
        left: 3 + activeIdx * slotW,
        width: slotW, borderRadius: 14,
        background: COLOR.bgWhite,
        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
        transition: "left 0.3s cubic-bezier(0.25, 1, 0.5, 1)",
      }} />
      {/* 选项文字 */}
      {options.map((o) => (
        <div key={o.id} onClick={() => onChange(o.id)} style={{
          position: "relative", zIndex: 1, flex: 1,
          textAlign: "center", cursor: "pointer",
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
          color: o.id === value ? COLOR.btn : COLOR.text5,
          transition: "color 0.25s",
          lineHeight: "28px",
          whiteSpace: "nowrap",
        }}>
          {o.label}
        </div>
      ))}
    </div>
  );
}
