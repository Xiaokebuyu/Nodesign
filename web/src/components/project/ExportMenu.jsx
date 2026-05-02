import { useEffect, useRef } from 'react';
import { FileCode, FileText, Presentation, Hammer, FolderOpen } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

const ITEMS = [
  { id: 'html',     icon: FileCode,     label: 'Standalone HTML',    desc: '单文件，可双击打开' },
  { id: 'pdf',      icon: FileText,     label: 'PDF',                desc: 'playwright print 1280×720（矢量文字）' },
  { id: 'pptx',     icon: Presentation, label: 'PowerPoint (.pptx)', desc: '每页截图嵌 PPTX（位图，文字不可编辑）' },
  { id: 'handoff',  icon: Hammer,       label: '工程交付包',           desc: 'ZIP: HTML + spec + assets + README' },
];

/**
 * ExportMenu — 顶栏导出下拉
 *
 * 三项 active（HTML / PDF / Handoff）调 GET /api/projects/:pid/exports/:format
 * 由父级 onExport 接走 Exports.download → blob → a.click()
 *
 * PPTX 标灰禁点，留 P0+。
 */
export default function ExportMenu({ open, onClose, onExport, anchorRef, onOpenList }) {
  const ref = useRef(null);

  // 点外面关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', right: 0,
        minWidth: 240,
        background: '#fff',
        border: `1px solid ${COLOR.borderMd}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
        padding: 4,
        zIndex: 50,
      }}
    >
      {ITEMS.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onExport?.(item.id);
              onClose?.();
            }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'flex-start', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              opacity: item.disabled ? 0.45 : 1,
            }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon size={14} color={COLOR.text4} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>{item.label}</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>{item.desc}</div>
            </div>
          </button>
        );
      })}

      {/* C31：分隔线 + 已生成的交付文件入口（agent export_handoff 写到 workspace/exports/）*/}
      {onOpenList && (
        <>
          <div style={{ height: 1, background: COLOR.borderLt, margin: `4px ${GAP.sm}px` }} />
          <button
            onClick={() => { onOpenList(); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <FolderOpen size={14} color={COLOR.text4} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text }}>已生成的交付文件</div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, marginTop: 1 }}>agent 主动 export_handoff 后产出</div>
            </div>
          </button>
        </>
      )}
    </div>
  );
}
