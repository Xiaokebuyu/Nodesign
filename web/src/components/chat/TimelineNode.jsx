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
 *   - 不在 group 里时（position=null）保持 v2 行为：全长
 *
 * ⭐ v4（2026-08-30）：**线断开，不再拿一块底色去盖。**
 *   v2 的"打断"是在 icon 底下铺一块不透明方片，颜色写死 WORKBENCH.panel ——
 *   那是 ThreeColumnLayout 左栏的色，而那个布局**现在一个调用方都没有了**：
 *   聊天早就搬到 ChatDock 那张纸上（PAPER.paper + GRAIN），方片的颜色再没跟过去。
 *   08-30 纸的颗粒加重之后当场现形。真机量到的（生产，聊天卡上）：
 *     方片 background #FBF7EC / background-image: none
 *     纸   background #FFFEF9 / background-image: GRAIN
 *   —— 颜色差一档，而且是**平的**：满屏纸纹里一个个光滑的小方。
 *
 *   所以不盖了，改成上下两截线各自让开图标。这样它跟纸的颜色、颗粒、季节皮肤、
 *   夜里那层光**永远不会再对不上** —— 因为它压根不参与配色。
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

  // icon 相对节点顶部的中心 y（top + height/2），线在这儿断开
  const ICON_TOP = GAP.sm + 3;
  const ICON_CENTER_FROM_TOP = ICON_TOP + ICON_SIZE / 2;
  const BREAK = ICON_SIZE / 2 + 3;   // 线到图标之间留的那口气

  const position = useTimelinePosition(); // 'first' | 'last' | 'only' | 'middle' | null

  // 图标上下两截线，各自决定画不画：first 上面没有来路，last 下面没有去路
  const showUp = position !== 'first' && position !== 'only';
  const showDown = position !== 'last' && position !== 'only';
  const lineX = PAD_LEFT + NODE_AREA / 2 - 0.5;
  const seg = (extra) => ({
    position: 'absolute', left: lineX, width: 1,
    background: COLOR.borderLt, pointerEvents: 'none', ...extra,
  });

  return (
    <div style={{
      position: 'relative',
      padding: `${GAP.sm}px ${GAP.lg}px ${GAP.sm}px ${PAD_LEFT + NODE_AREA + CONTENT_GAP}px`,
      minWidth: 0,
    }}>
      {showUp && <div style={seg({ top: 0, height: ICON_CENTER_FROM_TOP - BREAK })} />}
      {showDown && <div style={seg({ top: ICON_CENTER_FROM_TOP + BREAK, bottom: 0 })} />}
      <div style={{
        position: 'absolute',
        left: PAD_LEFT + (NODE_AREA - ICON_SIZE) / 2,
        top: ICON_TOP,
        width: ICON_SIZE,
        height: ICON_SIZE,
        // ⛔ 这里不许再有 background：线已经自己断开了，不需要谁去盖。
        //    一旦铺底色，就得永远追着纸的颜色 / 颗粒 / 季节皮肤跑（追丢过两次）。
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
