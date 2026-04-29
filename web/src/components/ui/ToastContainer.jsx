import { useEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';

/**
 * ToastContainer — 全局 toast 渲染（右下角 stack）
 *
 * 挂在 App.jsx 根上，独立于路由。读 globalStore.toasts，
 * 每条 toast 3.5s 自动 dismiss（除非 manual close）。
 */
const KIND_CONFIG = {
  success: { icon: CheckCircle2, color: COLOR.success, bg: 'rgba(74,138,74,0.08)' },
  error:   { icon: AlertCircle,  color: COLOR.error,   bg: 'rgba(184,58,42,0.08)' },
  info:    { icon: Info,         color: COLOR.text4,   bg: '#fff' },
};

export default function ToastContainer() {
  const toasts = useGlobalStore(s => s.toasts);
  const dismissToast = useGlobalStore(s => s.dismissToast);

  return (
    <div style={{
      position: 'fixed',
      right: 16, bottom: 16,
      zIndex: 1000,
      display: 'flex', flexDirection: 'column-reverse', gap: GAP.sm,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <Toast key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  const cfg = KIND_CONFIG[toast.kind] || KIND_CONFIG.info;
  const Icon = cfg.icon;

  useEffect(() => {
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div style={{
      pointerEvents: 'auto',
      minWidth: 240, maxWidth: 360,
      padding: `${GAP.md}px ${GAP.lg}px`,
      background: cfg.bg,
      border: `1px solid ${COLOR.borderMd}`,
      borderRadius: 8,
      boxShadow: '0 4px 12px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.05)',
      display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
      animation: 'toastIn 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
    }}>
      <Icon size={14} color={cfg.color} style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{
        flex: 1,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
        lineHeight: 1.4,
        wordBreak: 'break-word',
      }}>{toast.msg}</span>
      <button
        onClick={onDismiss}
        style={{
          width: 18, height: 18, borderRadius: 3,
          color: COLOR.sub, opacity: 0.6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = 0.6; }}
      >
        <X size={11} />
      </button>
      <style>{`
        @keyframes toastIn {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
