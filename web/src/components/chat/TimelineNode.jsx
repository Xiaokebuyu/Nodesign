import { COLOR, GAP } from '../../lib/theme.js';
import { useTimelinePosition } from './TimelineGroupContext.js';

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
 * v3 改动（修线段溢出 bug）：
 *   - 从 TimelineGroupContext 读 position（'first'/'last'/'only'/'middle'）
 *   - 'last' 时线只到 icon center 停（不溢出 done icon 之下）
 *   - 'first' 时线从 icon center 开始（不溢出 group title 与第一个 icon 之间）
 *   - 'only' 不画线（单节点 group 罕见但要 cover）
 *   - 不在 group 里时（position=null）保持 v2 行为：top:0 / bottom:0 全长
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

  // icon 相对节点顶部的中心 y（top + height/2），用于计算 first/last 线裁剪边界
  const ICON_TOP = GAP.sm + 3;
  const ICON_CENTER_FROM_TOP = ICON_TOP + ICON_SIZE / 2;

  const position = useTimelinePosition(); // 'first' | 'last' | 'only' | 'middle' | null

  // 线的 top/bottom（数字 = px from top；string = CSS expr from bottom edge）
  let lineTop = 0;
  let lineBottom = 0;
  let hideLine = false;
  if (position === 'only') {
    hideLine = true;
  } else if (position === 'first') {
    lineTop = ICON_CENTER_FROM_TOP;
  } else if (position === 'last') {
    lineBottom = `calc(100% - ${ICON_CENTER_FROM_TOP}px)`;
  }

  return (
    <div style={{
      position: 'relative',
      padding: `${GAP.sm}px ${GAP.lg}px ${GAP.sm}px ${PAD_LEFT + NODE_AREA + CONTENT_GAP}px`,
      minWidth: 0,
    }}>
      {!hideLine && (
        <div style={{
          position: 'absolute',
          left: PAD_LEFT + NODE_AREA / 2 - 0.5,
          top: lineTop,
          bottom: lineBottom,
          width: 1,
          background: COLOR.borderLt,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{
        position: 'absolute',
        left: PAD_LEFT + (NODE_AREA - ICON_SIZE) / 2,
        top: ICON_TOP,
        width: ICON_SIZE,
        height: ICON_SIZE,
        background: '#fff',
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {/* isSpinning prop 保留接口（callers 还在传），但不再做 spin animation
            —— 用户反馈 spin 不好看，改用 children 内容 shimmer 表达 streaming */}
        <Icon
          size={ICON_SIZE}
          color={iconColor}
          strokeWidth={1.75}
        />
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
