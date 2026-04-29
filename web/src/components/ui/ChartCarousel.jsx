import { useState, useRef, useEffect } from "react";
import { COLOR, GAP, DESK } from "../../lib/theme.js";
import ToggleSwitch from "./ToggleSwitch.jsx";

/**
 * 图表轮播容器 — 选择栏在内部顶栏，高度自适应内容
 * 切换时用 opacity + translateY 过渡，每个 tab 高度由内容决定
 */
export default function ChartCarousel({ tabs, minHeight = 200 }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const [displayId, setDisplayId] = useState(tabs[0]?.id);
  const [fading, setFading] = useState(false);

  const handleChange = (id) => {
    if (id === activeId) return;
    setFading(true);
    setTimeout(() => {
      setDisplayId(id);
      setActiveId(id);
      requestAnimationFrame(() => setFading(false));
    }, 200);
  };

  const activeTab = tabs.find(t => t.id === displayId);

  return (
    <div style={{
      marginBottom: GAP.xl, overflow: "hidden", borderRadius: DESK.radius,
      background: COLOR.gradDesk,
      border: DESK.borderClosed,
      boxShadow: DESK.shadowClosed,
    }}>
      {/* 选择栏 — 内部顶栏 */}
      <div style={{
        display: "flex", justifyContent: "center",
        padding: `${GAP.base}px ${GAP.xl}px ${GAP.sm}px`,
      }}>
        <ToggleSwitch
          options={tabs.map(t => ({ id: t.id, label: t.label }))}
          value={activeId}
          onChange={handleChange}
          width={Math.max(280, tabs.length * 90)}
        />
      </div>

      {/* 内容区 — opacity 过渡，高度自适应 */}
      <div style={{
        padding: `${GAP.md}px ${GAP.xxl}px ${GAP.xl}px`,
        minHeight,
        opacity: fading ? 0 : 1,
        transform: fading ? "translateY(8px)" : "translateY(0)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
      }}>
        {activeTab?.content}
      </div>
    </div>
  );
}
