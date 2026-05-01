import { COLOR, GAP } from '../../lib/theme.js';

/**
 * TimelineNode — agent 工作流时间轴的一个节点（v2：去外环）
 *
 * 视觉：
 *   ┌─ 左侧 14px 线性 icon（lucide stroke，直接亮出，无 border circle）
 *   │  + 下方 1px 灰色竖线（贯穿 message，相邻节点连成一条时间轴）
 *   └─ 右侧自然缩进的内容区
 *
 * v1 → v2 改动（参考用户图反馈）：
 *   - 去掉外圆环 wrapper（22px circle + border + status 色边框）
 *   - icon 直接亮出，背景白色"打断"时间轴线（避免线从 icon 中间穿过）
 *   - 状态色不再靠外环表达，靠 iconColor 本身（warn / success / error / sub）
 *
 * 用户期望的视觉更克制：thinking 用 Clock 类、Edit 用 Pencil、Read 用
 * FileText 等，每个 icon 只是简单的 stroke 形状，没有色环装饰。
 */
export default function TimelineNode({
  icon: Icon,
  iconColor = COLOR.sub,
  isSpinning = false,
  children,
}) {
  const ICON_SIZE = 14;
  const NODE_AREA = 18;
  const PAD_LEFT = GAP.lg;
  const CONTENT_GAP = GAP.sm;

  return (
    <div style={{
      position: 'relative',
      padding: `${GAP.sm}px ${GAP.lg}px ${GAP.sm}px ${PAD_LEFT + NODE_AREA + CONTENT_GAP}px`,
      minWidth: 0,
    }}>
      <div style={{
        position: 'absolute',
        left: PAD_LEFT + NODE_AREA / 2 - 0.5,
        top: 0, bottom: 0,
        width: 1,
        background: COLOR.borderLt,
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        left: PAD_LEFT + (NODE_AREA - ICON_SIZE) / 2,
        top: GAP.sm + 3,
        width: ICON_SIZE,
        height: ICON_SIZE,
        background: '#fff',
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Icon
          size={ICON_SIZE}
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
