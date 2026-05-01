import { COLOR, GAP } from '../../lib/theme.js';

/**
 * TimelineNode — agent 工作流时间轴的一个节点
 *
 * 视觉（参考用户提供图）：
 *   ┌─ 左 22px 圆形线性 icon（stroke 边框 + 内部 lucide 线性图标）
 *   │  + 下方 1px 灰色竖线（贯穿整条 message，相邻节点自然连成时间轴）
 *   └─ 右侧缩进的内容区
 *
 * 设计意图：
 *   - 统一 thinking / tool use 视觉，用户一眼看出"agent 在按步骤推进"
 *   - 线性 icon（lucide stroke）匹配项目克制审美，避免 filled 噪点
 *   - isSpinning 时 icon 旋转 → 流式信号
 *   - 节点边框颜色（iconBorder）随状态变（running=warn / success=success / error=error）
 */
export default function TimelineNode({
  icon: Icon,
  iconColor = COLOR.text4,
  iconBorder = COLOR.borderMd,
  iconBackground = '#fff',
  isSpinning = false,
  children,
}) {
  const ICON_SIZE = 22;
  const ICON_INNER = 12;
  const PAD_LEFT = GAP.lg;
  const CONTENT_GAP = GAP.sm;

  return (
    <div style={{
      position: 'relative',
      padding: `${GAP.sm}px ${GAP.lg}px ${GAP.sm}px ${PAD_LEFT + ICON_SIZE + CONTENT_GAP}px`,
      minWidth: 0,
    }}>
      <div style={{
        position: 'absolute',
        left: PAD_LEFT + ICON_SIZE / 2 - 0.5,
        top: 0, bottom: 0,
        width: 1,
        background: COLOR.borderLt,
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        left: PAD_LEFT,
        top: GAP.sm + 1,
        width: ICON_SIZE, height: ICON_SIZE,
        borderRadius: ICON_SIZE / 2,
        background: iconBackground,
        border: `1px solid ${iconBorder}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1,
      }}>
        <Icon
          size={ICON_INNER}
          color={iconColor}
          strokeWidth={1.75}
          style={isSpinning ? { animation: 'nd-tl-spin 1.4s linear infinite' } : undefined}
        />
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>

      <style>{`
        @keyframes nd-tl-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
