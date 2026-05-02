import { useState, useRef, useEffect } from 'react';
import { Layers, Check, RotateCcw } from 'lucide-react';
import { usePanelManager } from './PanelManager.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS, STAGE } from '../../lib/theme.js';

/**
 * PanelMenu — TopBar dropdown：列出所有 panel + checkbox 控制 visible +
 *              "重置布局"按钮
 *
 * Canvas 焕新升级 F2.3 + F3.2（合并）。
 *
 * 显示：图标 button (Layers) → 点开 dropdown：
 *   - 列出 panelMeta 注册的所有 panel（icon + label + ✓ if visible）
 *   - 点 panel 行 → toggle visible
 *   - 分隔线
 *   - "重置布局" 按钮（清 localStorage + 回 default）
 *
 * 用 usePanelManager() 拿 panels / panelMeta / togglePanel / resetLayout。
 */
export default function PanelMenu() {
  const { panels, panelMeta, togglePanel, resetLayout } = usePanelManager();
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  // 点外面关掉
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // 收集 panel 列表（panelMeta 注册的优先；其他 fallback 用 id）
  const ids = Object.keys(panels || {});
  const items = ids.map(id => ({
    id,
    label: panelMeta[id]?.label || id,
    Icon: panelMeta[id]?.icon || null,
    visible: panels[id]?.visible !== false,
  }));

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        title="面板布局"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          padding: `${GAP.xs + 1}px ${GAP.md}px`,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          color: open ? COLOR.text : COLOR.text4,
          background: open ? 'rgba(0,0,0,0.04)' : 'transparent',
          border: 'none', borderRadius: 6,
          cursor: 'pointer',
          transition: 'background 0.15s',
        }}
      >
        <Layers size={13} /> 面板
      </button>

      {open && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0,
            minWidth: 200,
            background: '#fff',
            borderRadius: STAGE.radius,
            boxShadow: STAGE.shadow,
            border: `1px solid ${STAGE.borderWarm}`,
            overflow: 'hidden',
            zIndex: 500,
          }}
        >
          <div style={{
            padding: `${GAP.md}px ${GAP.lg}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            color: COLOR.sub,
            borderBottom: `1px solid ${STAGE.borderWarm}`,
          }}>
            面板可见性
          </div>

          <div style={{ padding: `${GAP.xs}px 0` }}>
            {items.map(it => {
              const Icon = it.Icon;
              return (
                <button
                  key={it.id}
                  onClick={() => togglePanel(it.id)}
                  style={{
                    width: '100%',
                    display: 'flex', alignItems: 'center', gap: GAP.sm,
                    padding: `${GAP.sm + 1}px ${GAP.lg}px`,
                    border: 'none', background: 'transparent',
                    fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
                    color: COLOR.text2,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {Icon ? <Icon size={12} style={{ color: COLOR.text4 }} /> : <span style={{ width: 12 }} />}
                  <span style={{ flex: 1 }}>{it.label}</span>
                  <Check
                    size={12}
                    style={{
                      color: it.visible ? COLOR.btn : 'transparent',
                    }}
                  />
                </button>
              );
            })}
          </div>

          <div style={{
            borderTop: `1px solid ${STAGE.borderWarm}`,
            padding: `${GAP.xs}px 0`,
          }}>
            <button
              onClick={() => { resetLayout(); setOpen(false); }}
              style={{
                width: '100%',
                display: 'flex', alignItems: 'center', gap: GAP.sm,
                padding: `${GAP.sm + 1}px ${GAP.lg}px`,
                border: 'none', background: 'transparent',
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
                color: COLOR.text4,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <RotateCcw size={12} style={{ color: COLOR.text4 }} />
              <span>重置布局</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
