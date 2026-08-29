import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { useAnchoredPosition } from '../../lib/anchored-popover.js';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { TEXT_FONT_CSS, TEXT_FONT_LABELS, TEXT_SIZE_LABELS } from '../../lib/text-fonts.js';
import SystemTab from '../context-panel/SystemTab.jsx';

/**
 * SystemPopover — 项目档案 popover（贴 toolbar Settings 按钮）
 *
 * 2026-05-07：A11y 留在这里（mock，次要工具）；Reload 改回 toolbar 直接显示。
 *
 * 内容：
 *   - 顶部 Canvas 工具（A11y）
 *   - 中部 SystemTab 4 段（Skill / DS / Model / Spec 摘要）
 */
export default function SystemPopover({
  anchorRef, onClose,
  project, deckSpec,
  projectId, sessionId,
  onA11yClick,
  // Tweaks 模式开关（2026-08-07 从工具栏挪进来）：它是**会话设置**不是工具 ——
  // 决定后端给 agent 注入哪一版提示词，设一次管一整段，不该常驻占工具位。
  tweaksEnabled = null, onTweaksEnabledChange = null,
}) {
  const canvasFont = useGlobalStore(st => st.canvasFont);
  const followAgent = useGlobalStore(st => st.followAgent);
  const setFollowAgent = useGlobalStore(st => st.setFollowAgent);
  const setCanvasFont = useGlobalStore(st => st.setCanvasFont);
  const ref = useRef(null);
  const anchored = useAnchoredPosition(anchorRef, 360);

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
        ...anchored,
        width: 360,
        background: COLOR.bgWhite,
        borderRadius: 2,
        boxShadow:
          '0 2px 4px rgba(43,33,23,0.04), 0 8px 20px rgba(43,33,23,0.08), 0 24px 48px rgba(43,33,23,0.10), inset 0 1px 0 rgba(255,254,246,0.8)',
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
        {/* Canvas 工具（A11y） */}
        {onA11yClick && (
          <div style={{
            padding: `${GAP.md}px ${GAP.lg}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
            display: 'flex', flexDirection: 'column', gap: GAP.sm,
          }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.sub, textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              Canvas 工具
            </div>
            <div style={{ display: 'flex', gap: GAP.sm }}>
              <button
                onClick={() => { onA11yClick(); onClose?.(); }}
                style={popoverToolBtn}
                title="无障碍审查（mock）"
              >
                <ShieldCheck size={11} /> A11y
              </button>
            </div>
          </div>
        )}

        {onTweaksEnabledChange && (
          <div style={{
            padding: `${GAP.md}px ${GAP.lg}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
            display: 'flex', alignItems: 'center', gap: GAP.sm,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text }}>
                Tweaks 模式
              </div>
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2, lineHeight: 1.5 }}>
                {tweaksEnabled
                  ? '开：agent 会主动把核心参数做成控件让你拖'
                  : '关：不暴露控件，改样式走对话'}
              </div>
            </div>
            <ToggleSwitch checked={!!tweaksEnabled} onChange={onTweaksEnabledChange} />
          </div>
        )}

        {/* 镜头跟随 agent（2026-08-08）。用户要「这项需要可以开关」——
            跟随本身早就有，缺的是一个能关掉它的地方：你在画布另一头摆自己的
            东西时，镜头被 agent 拽走很烦，而 8 秒接管冷却只能缓解、关不掉。 */}
        <div style={{
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
          display: 'flex', alignItems: 'center', gap: GAP.sm,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text }}>
              镜头跟随 agent
            </div>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2, lineHeight: 1.5 }}>
              {followAgent
                ? '开：agent 换到哪个产物，镜头就飞过去（你操作后 8 秒内不抢）'
                : '关：镜头只听你的；agent 在动什么看光圈'}
            </div>
          </div>
          <ToggleSwitch checked={followAgent} onChange={setFollowAgent} />
        </div>

        {/* 画布手写字体（2026-08-08）。放设置里而不是工具栏：它是设一次管很久的
            偏好，不是每次落笔都要选的东西。存 localStorage —— 是这台机器上这个
            人的手感，不是项目属性。 */}
        <div style={{
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
        }}>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text }}>
            画布手写字体
          </div>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2, marginBottom: GAP.sm }}>
            用「文字」工具（T）在画布上写字时用这个
          </div>
          <div style={{ display: 'flex', gap: GAP.xs, flexWrap: 'wrap' }}>
            {Object.entries(TEXT_FONT_LABELS).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCanvasFont({ ...canvasFont, font: k })}
                style={{
                  padding: `${GAP.xs}px ${GAP.sm}px`, borderRadius: RADIUS.md, cursor: 'pointer',
                  fontFamily: TEXT_FONT_CSS[k], fontSize: FONT_SIZE.sm,
                  border: `1px solid ${canvasFont.font === k ? COLOR.text : COLOR.borderLt}`,
                  background: canvasFont.font === k ? COLOR.text : 'transparent',
                  color: canvasFont.font === k ? COLOR.bg : COLOR.text2,
                }}
              >{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: GAP.xs, marginTop: GAP.sm }}>
            {Object.entries(TEXT_SIZE_LABELS).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCanvasFont({ ...canvasFont, size: k })}
                style={{
                  padding: `${GAP.xs}px ${GAP.sm}px`, borderRadius: RADIUS.md, cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                  border: `1px solid ${canvasFont.size === k ? COLOR.text : COLOR.borderLt}`,
                  background: canvasFont.size === k ? COLOR.text : 'transparent',
                  color: canvasFont.size === k ? COLOR.bg : COLOR.text2,
                }}
              >{label}</button>
            ))}
          </div>
        </div>

        <SystemTab project={project} deckSpec={deckSpec} projectId={projectId} />

        {/* （项目档案折叠区 2026-08-24 拆除：决策贴/spec.history 退役，长期事实住根 CLAUDE.md 与 记忆/） */}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: COLOR.bgCard,
        borderTop: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5,
        flexShrink: 0,
      }}>
        spec 不可在此编辑 — 改 spec 跟 agent 说，触发新 run。
      </div>
    </div>
  );
}

/** 极简 toggle（原来长在 CanvasToolbar 里，那条工具栏 2026-08-07 退役了） */
function ToggleSwitch({ checked, onChange, title }) {
  return (
    <button
      onClick={() => onChange?.(!checked)}
      title={title}
      style={{
        width: 28, height: 16, padding: 0, border: 'none',
        borderRadius: RADIUS.lg,
        background: checked ? COLOR.text : 'rgba(43,33,23,0.18)',
        position: 'relative', cursor: 'pointer',
        transition: 'background 0.15s', flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 14 : 2,
        width: 12, height: 12, borderRadius: RADIUS.round,
        background: COLOR.bgWhite, boxShadow: SHADOW.crispSm,
        transition: 'left 0.15s',
      }} />
    </button>
  );
}

const popoverToolBtn = {
  padding: `${GAP.xs + 1}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
  background: 'rgba(43,33,23,0.04)',
  border: 'none',
  borderRadius: RADIUS.sm,
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  cursor: 'pointer',
};
