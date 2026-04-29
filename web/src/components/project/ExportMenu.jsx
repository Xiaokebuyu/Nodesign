import { useEffect, useRef } from 'react';
import { Download, FileCode, FileText, Presentation, Package } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

const ITEMS = [
  { id: 'html',  icon: FileCode,     label: 'Standalone HTML',   desc: '单文件，可双击打开' },
  { id: 'pdf',   icon: FileText,     label: 'PDF',               desc: 'P7：playwright print' },
  { id: 'pptx',  icon: Presentation, label: 'PowerPoint (.pptx)', desc: 'P7：HTML → PPTX' },
  { id: 'zip',   icon: Package,      label: 'ZIP（含资料）',      desc: 'P7：项目完整打包' },
];

/**
 * ExportMenu — 顶栏导出下拉
 *
 * P2：UI 完整，HTML 走 mock 下载（fetch /mock/deck.html → blob → 下载）
 *      其他三项暂时 alert "P7 实现"
 */
export default function ExportMenu({ open, onClose, onExport, anchorRef }) {
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
            onClick={() => { onExport?.(item.id); onClose?.(); }}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'flex-start', gap: GAP.md,
              padding: `${GAP.sm + 1}px ${GAP.md + 2}px`,
              background: 'transparent',
              borderRadius: 4,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
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
    </div>
  );
}
