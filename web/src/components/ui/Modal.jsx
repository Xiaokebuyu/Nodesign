import { useEffect, useState } from 'react';
import { COLOR } from '../../lib/theme.js';
import { X } from 'lucide-react';
import { GAP, FONT_SIZE, FONT_KAI } from '../../lib/theme.js';
import { PAPER, GRAIN, PAPER_SHADOW, pinFill } from '../../lib/paper.js';

/**
 * 通用 Modal 容器 —— 全站 13 个弹窗都套这一层（2026-08-03 换纸）
 *
 * 换肤只动这一个文件是有前提的：所有弹窗都是 <Modal> 的 children，外壳（遮罩、
 * 纸、标题条、页脚按钮）在这里定死。弹窗**内部**的表单各写各的，所以这里额外
 * 导出 modalInput / modalLabel / modalHint 三个样式，改过的弹窗直接引，
 * 不要再各自手写一份边框圆角。
 *
 * 形态：一张钉在板子上的纸。板子被压暗（暖色遮罩，不是中性黑），纸没有圆角
 * （纸没有圆角），顶上一枚图钉，影子用最近那一档 —— 它确实浮在所有东西之上。
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
        background: visible ? PAPER.scrim : 'rgba(43,33,23,0)',
        backdropFilter: visible ? 'blur(3px)' : 'blur(0px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.3s, backdrop-filter 0.3s',
      }}
    >
      <div
        className="nd-vh-cap"
        style={{
          position: 'relative',
          width,
          maxWidth: 'calc(100vw - 48px)',
          /* 高度上限走 .nd-vh-cap（globals.css）：dvh 优先 + vh 兜底，
             内联样式写不出"同一属性两遍"那个兜底写法 */
          background: PAPER.paper,
          backgroundImage: GRAIN,
          borderRadius: 2,
          boxShadow: PAPER_SHADOW.near,
          transform: visible ? 'scale(1) translateY(0)' : 'scale(0.92) translateY(20px)',
          opacity: visible ? 1 : 0,
          transition: 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s',
          display: 'flex', flexDirection: 'column',
          fontFamily: FONT_KAI, color: PAPER.ink,
        }}
      >
        {/* 图钉：跟板子上那些纸同一种钉法，一眼看出是同一个世界的东西 */}
        <span style={{
          position: 'absolute', top: 9, left: '50%', marginLeft: -4.5,
          width: 9, height: 9, borderRadius: '50%', zIndex: 2, pointerEvents: 'none',
          background: pinFill(),
          boxShadow: '-1px 2px 3px rgba(43,33,23,0.45)',
        }} />

        {(title || closable) && (
          <div style={{
            padding: `${GAP.xl}px ${GAP.xl}px ${GAP.lg}px`,
            borderBottom: `1px solid ${PAPER.hair}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <span style={{
              fontSize: 17, fontWeight: 700, letterSpacing: '0.06em', color: PAPER.ink,
            }}>{title}</span>
            {closable && (
              <button
                onClick={onClose}
                style={{
                  width: 26, height: 26, borderRadius: '50%',
                  color: PAPER.pencil,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(43,33,23,0.06)';
                  e.currentTarget.style.color = PAPER.ink;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = PAPER.pencil;
                }}
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

/**
 * 弹窗里的输入框：跟登录墙那张登记卡同一种写法 —— 没有框，只有一条底线，
 * 聚焦时底线变成墨色。在纸上画一个圆角方框等于在纸上又贴了一张纸。
 */
export const modalInput = {
  width: '100%',
  padding: '7px 2px',
  fontFamily: FONT_KAI, fontSize: FONT_SIZE.xxl,
  color: PAPER.ink,
  caretColor: PAPER.red,
  background: 'transparent',
  border: 'none',
  borderBottom: `1.5px solid ${PAPER.hair}`,
  borderRadius: 0,
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
};

/** 字段名：铅笔灰小字 + 宽字距，跟登记卡上的 label 同一档 */
export const modalLabel = {
  display: 'block',
  fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm,
  letterSpacing: '0.16em', color: PAPER.pencil,
  marginBottom: GAP.xs,
};

/** 说明性小字 */
export const modalHint = {
  fontFamily: FONT_KAI, fontSize: FONT_SIZE.md,
  color: PAPER.pencil, lineHeight: 1.75,
};

/** 输入框聚焦/失焦时底线的深浅（onFocus/onBlur 直接挂） */
export const modalInputFocus = {
  onFocus: (e) => { e.currentTarget.style.borderBottomColor = PAPER.ink; },
  onBlur: (e) => { e.currentTarget.style.borderBottomColor = PAPER.hair; },
};

/** Modal 内的标准 footer（取消 / 主按钮）*/
export function ModalFooter({ onCancel, onConfirm, confirmLabel = '确认', cancelLabel = '取消', confirmDisabled = false, danger = false }) {
  const accent = danger ? PAPER.red : PAPER.ink;
  return (
    <div style={{
      padding: `${GAP.lg}px ${GAP.xl}px ${GAP.xl}px`,
      borderTop: `1px solid ${PAPER.hair}`,
      display: 'flex', justifyContent: 'flex-end', gap: GAP.lg,
      flexShrink: 0,
    }}>
      <button
        onClick={onCancel}
        style={{
          padding: `${GAP.md - 1}px ${GAP.xl}px`,
          fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg,
          letterSpacing: '0.12em', textIndent: '0.12em',
          color: PAPER.pencil,
          background: 'transparent',
          border: '1px solid transparent',
          borderRadius: 2,
          cursor: 'pointer',
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = PAPER.ink2; }}
        onMouseLeave={e => { e.currentTarget.style.color = PAPER.pencil; }}
      >
        {cancelLabel}
      </button>
      {/* 主按钮跟「进 门」「开 工」同一种墨块 */}
      <button
        onClick={onConfirm}
        disabled={confirmDisabled}
        style={{
          padding: `${GAP.md - 1}px ${GAP.xxl}px`,
          fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, fontWeight: 700,
          letterSpacing: '0.22em', textIndent: '0.22em',
          color: confirmDisabled ? PAPER.pencil : COLOR.btnText,
          background: confirmDisabled ? 'transparent' : accent,
          border: `1px solid ${confirmDisabled ? PAPER.hair : accent}`,
          borderRadius: 2,
          cursor: confirmDisabled ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
