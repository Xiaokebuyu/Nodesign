import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * 通用 Modal 容器（DeskSkill 风格 mounted+visible 双状态 + rAF 双帧入场）
 *
 * 用法：
 *   <Modal show={open} onClose={() => setOpen(false)} title="新建项目" width={520}>
 *     ...children form...
 *   </Modal>
 *
 * 入场：scale(0.92) translateY(20) → scale(1) translateY(0)，0.4s cubic-bezier
 * 退场：先 visible=false 触发动画，400ms 后 setMounted=false 卸载
 */
export default function Modal({ show, onClose, title, width = 480, children, closable = true }) {
  const [mounted, setMounted] = useState(show);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true);
      // rAF 双帧：先挂 DOM，下一帧再触发动画（让 CSS transition 有起点）
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else if (mounted) {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 400);
      return () => clearTimeout(t);
    }
  }, [show]);

  // ESC 关闭
  useEffect(() => {
    if (!mounted) return;
    const onKey = (e) => { if (e.key === 'Escape' && closable) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mounted, closable, onClose]);

  if (!mounted) return null;

  return (
    <div
      onMouseDown={(e) => { if (closable && e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0,
        zIndex: 800,
        background: visible ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0)',
        backdropFilter: visible ? 'blur(3px)' : 'blur(0px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.3s, backdrop-filter 0.3s',
      }}
    >
      <div
        style={{
          width,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          background: 'linear-gradient(180deg, #fdfcfa 0%, #fff 30%)',
          border: `1px solid ${COLOR.borderLt}`,
          borderRadius: 16,
          boxShadow: '0 2px 4px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.8)',
          transform: visible ? 'scale(1) translateY(0)' : 'scale(0.92) translateY(20px)',
          opacity: visible ? 1 : 0,
          transition: 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {(title || closable) && (
          <div style={{
            padding: `${GAP.lg}px ${GAP.xl}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <span style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600, color: COLOR.text,
            }}>{title}</span>
            {closable && (
              <button
                onClick={onClose}
                style={{
                  width: 28, height: 28, borderRadius: 6,
                  color: COLOR.text4,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Modal 内的标准 footer（取消 / 主按钮）*/
export function ModalFooter({ onCancel, onConfirm, confirmLabel = '确认', cancelLabel = '取消', confirmDisabled = false, danger = false }) {
  return (
    <div style={{
      padding: `${GAP.lg}px ${GAP.xl}px`,
      borderTop: `1px solid ${COLOR.borderLt}`,
      display: 'flex', justifyContent: 'flex-end', gap: GAP.md,
      background: 'rgba(0,0,0,0.015)',
    }}>
      <button
        onClick={onCancel}
        style={{
          padding: `${GAP.sm}px ${GAP.xl}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
          color: COLOR.text2,
          background: 'rgba(0,0,0,0.04)',
          border: `1px solid ${COLOR.borderLt}`,
          borderRadius: 8,
          cursor: 'pointer',
        }}
      >
        {cancelLabel}
      </button>
      <button
        onClick={onConfirm}
        disabled={confirmDisabled}
        style={{
          padding: `${GAP.sm}px ${GAP.xl}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
          color: '#fff',
          background: confirmDisabled ? 'rgba(0,0,0,0.2)' : (danger ? COLOR.error : COLOR.btn),
          border: `1px solid ${confirmDisabled ? 'rgba(0,0,0,0.2)' : (danger ? COLOR.error : COLOR.btn)}`,
          borderRadius: 8,
          cursor: confirmDisabled ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s',
        }}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
