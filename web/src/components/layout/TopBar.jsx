import { Link } from 'react-router-dom';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * TopBar — 顶栏（h: 56px）
 *
 * @param {object} props
 * @param {Array<{label, to?}>} [props.breadcrumb]  - 面包屑 [{label:'Nodesign', to:'/'}, {label:'项目名'}]
 * @param {object} [props.status]                   - 状态指示 { dot: 'idle'|'running'|'failed', text: '运行中…' }
 * @param {ReactNode} [props.actions]               - 右侧操作区（按钮组）
 */
export default function TopBar({ breadcrumb = [], status, actions }) {
  return (
    <header style={{
      height: 56,
      flexShrink: 0,
      background: '#fff',
      borderBottom: `1px solid ${COLOR.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${GAP.xl}px`,
      gap: GAP.lg,
      boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
    }}>
      {/* Logo */}
      <Link to="/" style={{
        display: 'flex',
        alignItems: 'center',
        gap: GAP.md,
        fontFamily: FONT_MONO,
        fontSize: FONT_SIZE.h2,
        fontWeight: 600,
        color: COLOR.text,
        letterSpacing: '-0.01em',
      }}>
        <span style={{
          width: 24, height: 24, borderRadius: 6,
          background: COLOR.btn, color: COLOR.btnText,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700,
        }}>N</span>
        Nodesign
      </Link>

      {/* Breadcrumb */}
      {breadcrumb.length > 0 && (
        <>
          <span style={{ color: COLOR.dim, fontSize: FONT_SIZE.lg }}>/</span>
          <nav style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2, minWidth: 0 }}>
            {breadcrumb.map((item, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.sm, minWidth: 0 }}>
                {i > 0 && <span style={{ color: COLOR.dim }}>/</span>}
                {item.to ? (
                  <Link to={item.to} style={{ color: COLOR.text2 }}>{item.label}</Link>
                ) : (
                  <span style={{ color: COLOR.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        </>
      )}

      {/* Status */}
      {status && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
          color: status.dot === 'failed' ? COLOR.error : status.dot === 'running' ? COLOR.warn : COLOR.sub,
          padding: `${GAP.xs}px ${GAP.md}px`,
          background: status.dot === 'failed' ? 'rgba(184,58,42,0.08)' : status.dot === 'running' ? 'rgba(184,92,26,0.08)' : 'rgba(0,0,0,0.04)',
          borderRadius: 100,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 3,
            background: status.dot === 'failed' ? COLOR.error : status.dot === 'running' ? COLOR.warn : COLOR.success,
            animation: status.dot === 'running' ? 'pulse 1.6s ease-in-out infinite' : 'none',
          }} />
          {status.text}
          <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Actions */}
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md }}>{actions}</div>}
    </header>
  );
}
