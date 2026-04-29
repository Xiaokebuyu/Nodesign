import { useState, useMemo } from "react";
import { BROWSE, FONT_MONO, COLOR, GAP, FONT_SIZE } from "../../lib/theme.js";

export default function BrowsePage({ backLabel, onBack, icon, title, count, placeholder, items, filterFn, gridMin, renderCard, emptyText }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    return filterFn(items, search.toLowerCase());
  }, [items, search, filterFn]);

  return (
    <div style={{ padding: `0 0 ${GAP.page}px` }}>
      {/* 头部 */}
      <div style={{ display: "flex", alignItems: "center", gap: GAP.lg, marginBottom: GAP.xl }}>
        <button onClick={onBack} style={{
          background: "rgba(0,0,0,0.03)", border: `1px solid ${COLOR.border}`,
          borderRadius: BROWSE.backRadius, padding: BROWSE.backPadding, cursor: "pointer",
          fontSize: BROWSE.backFontSize, fontWeight: BROWSE.backFontWeight, color: BROWSE.backColor,
          transition: "all 0.2s",
        }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.06)"}
          onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
        >← {backLabel}</button>
        <div style={{ display: "flex", alignItems: "center", gap: GAP.sm }}>
          {icon}
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, color: "#5a4a32", letterSpacing: 0.3 }}>{title}</span>
          <span style={{ fontSize: FONT_SIZE.lg, color: COLOR.sub }}>共 {count} 件</span>
        </div>
      </div>

      {/* 搜索框 — 锚定 Dashboard CardBrowse 标准 */}
      <div style={{ marginBottom: GAP.xl, position: "relative" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder={placeholder}
          style={{
            width: "100%", padding: "11px 14px 11px 38px",
            background: BROWSE.searchBg, border: `1px solid ${COLOR.border}`,
            borderRadius: BROWSE.searchRadius, outline: "none",
            fontSize: BROWSE.searchFontSize, color: "#3a3028",
            boxSizing: "border-box",
            transition: "all 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
          onFocus={e => { e.target.style.borderColor = "rgba(0,0,0,0.1)"; e.target.style.boxShadow = "0 1px 6px rgba(0,0,0,0.08)"; }}
          onBlur={e => { e.target.style.borderColor = COLOR.border; e.target.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"; }}
        />
        <span style={{
          position: "absolute", left: GAP.lg, top: "50%", transform: "translateY(-50%)",
          fontSize: FONT_SIZE.xxl, color: "#c0b8a8", pointerEvents: "none",
        }}>🔍</span>
      </div>

      {/* 网格 */}
      {filtered.length > 0 ? (
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fill, minmax(${gridMin || BROWSE.gridMin}px, 1fr))`,
          gap: 14, justifyItems: "center",
        }}>
          {filtered.map(renderCard)}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: `${GAP.page}px ${GAP.xxl}px`, fontSize: FONT_SIZE.xxl, color: "#b0a898" }}>
          {emptyText || `没有找到匹配「${search}」的内容`}
        </div>
      )}
    </div>
  );
}
