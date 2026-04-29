import { useState, useRef, useCallback } from "react";
import { Upload } from "lucide-react";
import { FONT_MONO, FONT_SANS, COLOR, GAP, FONT_SIZE } from "../../lib/theme.js";

/**
 * Markdown 编辑输入 — 手写 + 拖拽/点选 .md 文件自动解析
 * 拖入或选择 .md 文件后，用 FileReader 读取文本内容填入 textarea
 */
export default function MarkdownInput({ value, onChange, placeholder, minHeight = 140 }) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileRef = useRef(null);

  const readFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result || "";
      onChange(value ? value + "\n\n" + text : text);
    };
    reader.readAsText(file, "utf-8");
  }, [value, onChange]);

  const acceptFile = useCallback((file) => {
    if (!file) return false;
    const name = file.name.toLowerCase();
    if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".txt") || file.type === "text/markdown" || file.type === "text/plain") {
      return true;
    }
    return false;
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer?.files || []);
    const mdFile = files.find(acceptFile);
    if (mdFile) readFile(mdFile);
  }, [readFile, acceptFile]);

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file && acceptFile(file)) readFile(file);
    e.target.value = "";
  };

  return (
    <div
      style={{ position: "relative" }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", minHeight, padding: `${GAP.base}px ${GAP.lg}px`,
          background: dragging ? "rgba(90,122,154,0.06)" : "rgba(0,0,0,0.02)",
          border: dragging ? "2px dashed rgba(90,122,154,0.4)" : `1px solid ${COLOR.borderMd}`,
          borderRadius: GAP.md, fontFamily: FONT_MONO, fontSize: FONT_SIZE.base,
          color: COLOR.text, lineHeight: 1.6, resize: "vertical",
          outline: "none", boxSizing: "border-box",
          transition: "border-color 0.15s, background 0.15s",
        }}
      />

      {/* 拖拽覆盖提示 */}
      {dragging && (
        <div style={{
          position: "absolute", inset: 0, borderRadius: GAP.md,
          background: "rgba(90,122,154,0.08)",
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.blue, fontWeight: 500 }}>
            松开以导入 .md 文件
          </div>
        </div>
      )}

      {/* 底部提示栏：上传 .md 按钮 */}
      <input ref={fileRef} type="file" accept=".md,.markdown,.txt" style={{ display: "none" }} onChange={handleFileSelect} />
      <div style={{
        display: "flex", justifyContent: "flex-end", marginTop: GAP.xs,
      }}>
        <span
          onClick={() => fileRef.current?.click()}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: "#9a8a78",
            cursor: "pointer", userSelect: "none",
            padding: `2px ${GAP.sm}px`, borderRadius: GAP.xs,
            transition: "color 0.15s",
          }}
          onMouseEnter={e => e.currentTarget.style.color = COLOR.blue}
          onMouseLeave={e => e.currentTarget.style.color = "#9a8a78"}
        >
          <Upload size={10} />导入 .md
        </span>
      </div>
    </div>
  );
}
