import { Edit3, Eye, Code2, RotateCcw, ShieldCheck, Maximize2, Settings, Sliders } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, STAGE } from '../../lib/theme.js';

const MODES = [
  { id: 'edit',    label: 'Edit',    icon: Edit3 },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'code',    label: 'Code',    icon: Code2 },
];

export default function CanvasToolbar({
  mode, onModeChange, onReload,
  zoom = 1, isAutoFit = false, onZoomChange, onFitToggle,
  onA11yClick, a11yBtnRef,
  onSystemClick, systemBtnRef, systemActive = false,
  onTweaksClick, tweaksAvailable = false, tweaksOpen = false,
}) {
  return (
    <div style={{
      height: 44,
      flexShrink: 0,
      borderBottom: `1px solid ${STAGE.borderWarm}`,    // 暖棕极淡边对齐 stage
      background: 'rgba(255,255,255,0.95)',             // 半透明白，融入 stage 卡片
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${GAP.lg}px`,
      gap: GAP.lg,
    }}>
      {/* Mode 切换 */}
      <div style={{
        display: 'inline-flex',
        background: 'rgba(0,0,0,0.04)',
        borderRadius: 6,
        padding: 2,
      }}>
        {MODES.map(m => {
          const Icon = m.icon;
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => onModeChange?.(m.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
                padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
                color: active ? COLOR.text : COLOR.sub,
                background: active ? '#fff' : 'transparent',
                borderRadius: 4,
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              <Icon size={11} />
              {m.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* Zoom — fit 模式自动按 canvas 宽算；+/- 切到 manual；Fit 按钮回 fit */}
      {onZoomChange && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        }}>
          {onFitToggle && (
            <button
              onClick={onFitToggle}
              title={isAutoFit ? '已 fit canvas' : '自适应 canvas 宽度'}
              style={{
                ...zoomBtnStyle,
                width: 'auto', padding: `0 ${GAP.sm}px`,
                color: isAutoFit ? COLOR.text : COLOR.sub,
                background: isAutoFit ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.04)',
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              }}
            >
              <Maximize2 size={10} /> Fit
            </button>
          )}
          <button onClick={() => onZoomChange(Math.max(0.25, zoom - 0.1))} style={zoomBtnStyle}>−</button>
          <span style={{ minWidth: 36, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => onZoomChange(Math.min(3, zoom + 0.1))} style={zoomBtnStyle}>+</button>
        </div>
      )}

      {/* Tweaks 浮窗 toggle — agent expose 过控件后才显示 */}
      {tweaksAvailable && onTweaksClick && (
        <button
          onClick={onTweaksClick}
          style={{
            padding: `${GAP.xs + 1}px ${GAP.md}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            color: tweaksOpen ? COLOR.text : COLOR.text4,
            background: tweaksOpen ? 'rgba(0,0,0,0.06)' : 'transparent',
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            borderRadius: 4,
          }}
          title={tweaksOpen ? '关闭 Tweaks 面板' : '打开 Tweaks 面板（拖控件实时改样式）'}
        >
          <Sliders size={11} /> Tweaks
        </button>
      )}

      {/* A11y review */}
      {onA11yClick && (
        <button
          ref={a11yBtnRef}
          onClick={onA11yClick}
          style={{
            padding: `${GAP.xs + 1}px ${GAP.md}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            borderRadius: 4,
          }}
          title="无障碍审查（mock）"
        >
          <ShieldCheck size={11} /> A11y
        </button>
      )}

      {/* System — 项目档案 popover */}
      {onSystemClick && (
        <button
          ref={systemBtnRef}
          onClick={onSystemClick}
          style={{
            padding: `${GAP.xs + 1}px ${GAP.sm + 1}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            color: systemActive ? COLOR.text : COLOR.text4,
            background: systemActive ? 'rgba(0,0,0,0.06)' : 'transparent',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4,
          }}
          title="System — skill / 设计系统 / 模型 / spec / 项目档案"
        >
          <Settings size={11} />
        </button>
      )}

      {/* Reload */}
      {onReload && (
        <button onClick={onReload} style={{
          padding: `${GAP.xs + 1}px ${GAP.md}px`,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          borderRadius: 4,
        }} title="重载 iframe">
          <RotateCcw size={11} /> Reload
        </button>
      )}
    </div>
  );
}

const zoomBtnStyle = {
  width: 22, height: 22,
  fontFamily: 'inherit', fontSize: 12,
  color: '#3a2a18',
  background: 'rgba(0,0,0,0.04)',
  borderRadius: 4,
};
