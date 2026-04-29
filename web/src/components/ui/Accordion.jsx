import { useRef, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { COLOR, GAP } from "../../lib/theme.js";

/**
 * 手风琴组件 — 同一时间只展开一个 item
 * @param {{ items: {key:string, header:ReactNode, content:ReactNode}[], expandedKey: string|null, onToggle: (key:string)=>void }} props
 */
export default function Accordion({ items, expandedKey, onToggle }) {
  return (
    <div>
      {items.map(item => (
        <AccordionItem
          key={item.key}
          item={item}
          expanded={expandedKey === item.key}
          onToggle={() => onToggle(item.key)}
        />
      ))}
    </div>
  );
}

function AccordionItem({ item, expanded, onToggle }) {
  const contentRef = useRef(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (expanded && contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  }, [expanded, item.content]);

  return (
    <div style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
      {/* Header — 可点击 */}
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: GAP.sm,
          padding: `${GAP.base}px ${GAP.lg}px`, cursor: "pointer",
          transition: "background 0.15s",
        }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.02)"}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      >
        <ChevronRight
          size={14}
          style={{
            color: COLOR.sub, flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        />
        <div style={{ flex: 1 }}>{item.header}</div>
      </div>

      {/* Content — max-height 动画 */}
      <div style={{
        maxHeight: expanded ? height : 0,
        opacity: expanded ? 1 : 0,
        overflow: "hidden",
        transition: "max-height 0.35s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s ease",
      }}>
        <div ref={contentRef} style={{ padding: `0 ${GAP.lg}px ${GAP.lg}px 32px` }}>
          {item.content}
        </div>
      </div>
    </div>
  );
}
