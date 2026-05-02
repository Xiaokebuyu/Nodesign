import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Settings as SettingsIcon } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import SystemTab from '../context-panel/SystemTab.jsx';
import DecisionsTab from '../context-panel/DecisionsTab.jsx';

/**
 * SystemPopover — 项目档案 popover（贴 toolbar Settings 按钮）
 *
 * 替代原来的 system / decisions floating panel：
 *   - 顶部 SystemTab 4 段（Skill / DS / Model / Spec 摘要）
 *   - 底部"项目档案"折叠（默认收起）：展开后嵌 DecisionsTab（含 decisions + history）
 *
 * 形状：跟 A11yReviewPopover 同款（top:78 right:16，click-outside 关）。
 * 跟 A11y 互斥（同侧不能同时显示，由 CanvasFrame 切 state 时互斥控制）。
 */
export default function SystemPopover({
  anchorRef, onClose,
  project, deckSpec,
  projectId, sessionId, decisionsReloadKey = 0,
}) {
  const ref = useRef(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  // 点外面关
  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose, anchorRef]);

  // ESC 关
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 78, right: 16,
        width: 360,
        maxHeight: 'calc(100% - 100px)',
        background: '#fff',
        border: `1px solid ${COLOR.borderMd}`,
        borderRadius: 10,
        boxShadow:
          '0 2px 4px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
        zIndex: 60,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        flexShrink: 0,
      }}>
        <SettingsIcon size={12} color={COLOR.text4} />
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
        }}>System</span>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <SystemTab project={project} deckSpec={deckSpec} />

        {/* 项目档案 折叠 — 默认收起（agent 内部知识，用户偶尔翻） */}
        <div style={{
          borderTop: `1px solid ${COLOR.borderLt}`,
          padding: `${GAP.md}px ${GAP.lg}px 0`,
        }}>
          <button
            onClick={() => setArchiveOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: GAP.xs,
              width: '100%', padding: `${GAP.xs}px 0`,
              background: 'transparent', border: 'none',
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.sub, textTransform: 'uppercase', letterSpacing: '0.05em',
              cursor: 'pointer',
            }}
          >
            <ChevronRight
              size={11}
              style={{
                transform: archiveOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.12s ease',
              }}
            />
            项目档案 — Decisions / History
          </button>
          {!archiveOpen && (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              padding: `${GAP.xs}px 0 ${GAP.md}px ${GAP.lg}px`,
              lineHeight: 1.5,
            }}>
              展开看 agent 记录的设计决策 + compact 摘要历史。
            </div>
          )}
        </div>

        {archiveOpen && (
          <div style={{
            background: 'rgba(0,0,0,0.015)',
            margin: `0 ${GAP.lg}px ${GAP.md}px`,
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: 6,
          }}>
            <DecisionsTab
              projectId={projectId}
              sessionId={sessionId}
              reloadKey={decisionsReloadKey}
            />
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: COLOR.bgCard,
        borderTop: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, lineHeight: 1.5,
        flexShrink: 0,
      }}>
        spec 不可在此编辑 — 改 spec 跟 agent 说，触发新 run。
      </div>
    </div>
  );
}
