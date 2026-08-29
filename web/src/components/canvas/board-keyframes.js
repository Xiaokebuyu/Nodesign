/**
 * 画布的 @keyframes 全表（2026-08-17 从 BoardCanvas 的内联 <style> 拆出）。
 *
 * 拆它的理由不只是行数：这是一坨**纯常量**，跟那两千多行状态、手势、命中判据
 * 没有任何关系，混在 render 顶上只会让人每次读 JSX 都先翻过它。
 *
 * 没进 globals.css：这些动画只有画布这一层用，跟画布一起加载、一起被找到，
 * 比散进全站样式表好。`nd` 前缀是全站约定。
 */
import { TERM, CANVAS, alpha } from '../../lib/theme.js';

export const BOARD_KEYFRAMES = [
  '@keyframes ndPopIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}',
  '@keyframes ndStageOut{to{opacity:0;transform:scale(.97)}}',
  // 流光：一个动画周期必须**正好走完一个图案周期**，否则每次 loop 重启时
  // 花纹相位对不上，看着就是"扫到一半跳一下"。
  // background-size:200% 时 offset(p) = (W - 2W)·p = -W·p，
  // 100% → -100% 的位移正好是 2W = 一个图案宽。
  // （原来是 size 240% + 200%→-60%：位移 3.64W / 周期 2.4W = 1.517 个周期，
  //   每 1.5s 跳一次。）
  '@keyframes ndShimmer{from{background-position:100% 0}to{background-position:-100% 0}}',
  '@keyframes ndCaret{0%,100%{opacity:1}50%{opacity:0}}',
  '@keyframes ndSpin{to{transform:rotate(360deg)}}',
  '@keyframes ndPresencePulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.25);opacity:.75}}',
  `@keyframes ndPulse{from{box-shadow:0 0 0 0 ${alpha(TERM.edgeOk, 0.4)}}to{box-shadow:0 0 0 12px ${alpha(TERM.edgeOk, 0)}}}`,
  // agent 正在动的目标：外圈橙色呼吸光圈
  // agent 正在动这个东西：**一圈跑动的光**，不只是边框在呼吸。
  // 用户要的是"运动环绕光圈"—— 呼吸是"这里有点什么"，跑动才是"有人正在
  // 这儿干活"。两层叠着：底下一圈稳的实边（认得出是哪一个），上面
  // 一段亮弧沿着边转（看得出在动）。
  `@keyframes ndAgentRing{0%,100%{box-shadow:0 0 0 2px ${alpha(CANVAS.brass, 0.85)},0 0 0 7px ${alpha(CANVAS.brass, 0.16)},0 6px 20px ${alpha(TERM.shade, 0.12)}}50%{box-shadow:0 0 0 2px ${alpha(CANVAS.brass, 0.95)},0 0 0 13px ${alpha(CANVAS.brass, 0.05)},0 6px 20px ${alpha(TERM.shade, 0.12)}}}`,
  // 亮弧沿边跑：转的是**渐变的起始角**，不是那个矩形。
  //
  // ⚠️ 原来写的是 `transform:rotate(1turn)` —— 那转的是整个遮罩矩形。只有正方
  // 卡在 90° 整数倍上才转回自己，真实产物卡（240×200、文字卡窄高）转到 45° 时
  // 那道光整个飞到卡外面，看着就是一道断掉的折线浮在卡上方。用户报的
  // 「流光破损」就是这个（2026-08-17 复现：把 CSS 原样搬进空白页逐相位截图）。
  //
  // 改法：注册成 <angle> 类型的自定义属性才能被插值（不注册的自定义属性只做
  // 离散动画，会在 50% 处直接跳一下）。BoardObject 那边写
  // `from var(--ndSweep, 0deg)` —— 万一浏览器不认 @property，回落成一段不动的
  // 静态弧，而不是整条 background 声明作废（那会让光圈整个消失）。
  '@property --ndSweep{syntax:"<angle>";inherits:false;initial-value:0deg}',
  '@keyframes ndAgentSweep{to{--ndSweep:360deg}}',
].join('');
