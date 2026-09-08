/**
 * sprite-figures.jsx —— 画布精灵的**身体**（2026-08-21）。
 *
 * 精灵的摆位、台词、找空位都在 SpriteSketchLayer.jsx；这里只管"它长什么样、怎么动"。
 * 拆开是因为接了 Claude 以外的模型之后，身体不再只有一种：**精灵跟着会话模型换身份**
 * （用户 08-21 拍板）。跑 DeepSeek 就是蓝鲸，跑 Ox 就是 OpenCode 的方块，跑 Claude 还是星芒。
 *
 * 三种身体共用同一套出场（铅笔描线 → 显影），各有各的"干活时怎么动"：
 *   - claude   星芒 12 根触点顺时针挤压-释放（原样搬过来，一个像素没改）
 *   - deepseek 鲸：常态是起伏/甩尾/呼吸/喷气四条**周期不整除**的动作叠在一起（看不出循环点），
 *              干活期间每隔一会儿潜一次 —— 潜是有信息量的动作，所以卡在"开始干活"和随机间隔上
 *   - opencode 方块光标：下半截填充块像终端光标那样涨落。Ox 是隐身模型，画供应商的标
 *   - glm      Z 的三笔顺序提亮（09-08）：**只在精灵上**，picker 里那枚是静态的
 *   - 其它（gemini/qwen）没有专门的动法：出场画法一样，干活时整体轻微呼吸
 *
 * 动画全在 CSS，节点不重挂 —— 精灵是常驻元素，React 侧只切 class 和几个计时器。
 */
import { useEffect, useRef, useState } from 'react';
import { PAPER } from '../../lib/paper.js';
import { CLAUDE_BRAND, CLAUDE_PATH } from '../ui/claude-mark.js';
import { MARKS, GLM_STROKES } from '../ui/ModelMark.jsx';

/**
 * GLM 三笔的错拍与周期。⭐ 跟鲸那四条同一条纪律：**周期别跟别的动作整除**，
 * 整除的话几秒就看出循环点 —— 那是「在放动画」不是「活着」。
 * 340 是二分出来的：260 显得慌，420 拖沓。
 */
const GLM_STEP = 340;
const GLM_PERIOD = 1900;

/** 描线用时（手写文字的起笔时刻拿它当 delay，字总在图标成形后才落） */
export const MARK_DRAW_MS = 760;

/** 鲸潜一次的全长；两次潜之间的随机间隔（毫秒）。改节奏改这三个数就够 */
const DIVE_MS = 2800;
const DIVE_GAP = [25_000, 45_000];
/** 开始干活后多久潜第一次 —— 潜是"开工了"的信号，所以贴着 active 起手 */
const DIVE_FIRST_MS = 700;

/**
 * 手绘矢量版星芒（2026-08-14 五版，用户拍板"整个用我们自己的手绘版，操作
 * 空间大"）：12 个触点 + 中心毂是**独立形状**，从官方轮廓按谷点解剖出来
 * （scratchpad/claude-rays2.mjs：触点尖=半径极大、谷=相邻尖之间半径极小，
 * 谷到谷的轮廓段闭合成一根触点，谷点连成 12 边形毂）。480px 逐像素 diff=0
 * —— 拼回去就是官方图，拆开每根都能自由动。
 * ox/oy = 谷弦中点 = 这根触点的"根"：挤压绕根缩，根钉在毂缘上永不开缝，
 * 前一版的 clip 裁切和圆片补丁整套退役。
 */
const HUB = 'M9.57 11.63L9.4 8.81L12.08 9.16L13.82 8.46L16.49 10.53L15.83 12.8L15.74 13.91L15.7 16.19L13.24 16.02L11.92 15.29L10.53 14.44L9.51 13.08Z';
const RAYS = [
  { d: 'M12.08 9.16L12.24 9.16L12.24 9.01L12.36 7.3L12.6 5.21L12.83 2.51L12.91 1.75L13.29 0.84L14.03 0.35L14.62 0.63L15.1 1.32L15.03 1.76L14.74 3.61L14.19 6.51L13.82 8.46Z', ox: 12.95, oy: 8.81 },  // tip 280°
  { d: 'M13.82 8.46L14.03 8.46L14.28 8.21L15.26 6.91L16.91 4.84L17.64 4.03L18.49 3.12L19.04 2.69L20.07 2.69L20.83 3.82L20.49 4.98L19.43 6.33L18.54 7.47L17.28 9.17L16.49 10.53Z', ox: 15.16, oy: 9.5 },  // tip 311°
  { d: 'M16.49 10.53L16.57 10.64L16.75 10.62L19.61 10.02L21.15 9.74L22.99 9.42L23.82 9.81L23.91 10.21L23.58 11.01L21.62 11.5L19.31 11.96L15.87 12.77L15.83 12.8Z', ox: 16.16, oy: 11.67 },  // tip 351°
  { d: 'M15.83 12.8L15.88 12.87L17.43 13.01L18.09 13.05L19.71 13.05L22.73 13.27L23.52 13.79L23.99 14.43L23.91 14.92L22.7 15.54L21.06 15.15L17.23 14.24L15.92 13.91L15.74 13.91Z', ox: 15.79, oy: 13.36 },  // tip 14°
  { d: 'M15.74 13.91L15.74 14.02L16.83 15.09L18.84 16.9L21.34 19.23L21.47 19.8L21.15 20.26L20.81 20.21L18.61 18.55L17.76 17.81L15.83 16.19L15.7 16.19Z', ox: 15.72, oy: 15.05 },  // tip 42°
  { d: 'M15.7 16.19L15.7 16.36L16.15 17.01L18.49 20.53L18.61 21.61L18.44 21.96L17.83 22.17L17.17 22.05L15.79 20.13L14.38 17.96L13.24 16.02Z', ox: 14.47, oy: 16.1 },  // tip 57°
  { d: 'M13.24 16.02L13.1 16.1L12.42 23.35L12.11 23.72L11.38 24L10.77 23.54L10.45 22.79L10.77 21.32L11.16 19.39L11.48 17.86L11.76 15.96L11.93 15.33L11.92 15.29Z', ox: 12.58, oy: 15.65 },  // tip 93°
  { d: 'M11.92 15.29L11.78 15.31L10.35 17.27L8.17 20.22L6.44 22.06L6.03 22.23L5.32 21.86L5.38 21.2L5.78 20.61L8.17 17.57L9.61 15.69L10.54 14.6L10.53 14.44Z', ox: 11.23, oy: 14.87 },  // tip 124°
  { d: 'M10.53 14.44L10.48 14.44L4.14 18.56L3.01 18.71L2.52 18.25L2.58 17.5L2.81 17.26L4.72 15.95L4.71 15.96L9.43 13.31L9.51 13.08Z', ox: 10.02, oy: 13.76 },  // tip 147°
  { d: 'M9.51 13.08L9.43 12.95L9.2 12.95L8.41 12.9L5.72 12.83L3.38 12.73L1.11 12.61L0.54 12.49L0.01 11.78L0.06 11.43L0.54 11.11L1.23 11.17L2.75 11.27L5.02 11.43L6.68 11.53L9.12 11.78L9.51 11.78L9.57 11.63Z', ox: 9.54, oy: 12.35 },  // tip 181°
  { d: 'M9.57 11.63L9.43 11.53L9.33 11.43L6.97 9.84L4.42 8.15L3.09 7.18L2.36 6.68L2 6.22L1.84 5.22L2.5 4.49L3.38 4.55L3.6 4.61L4.5 5.3L6.4 6.78L8.89 8.61L9.26 8.91L9.4 8.81Z', ox: 9.48, oy: 10.22 },  // tip 214°
  { d: 'M9.4 8.81L9.42 8.74L9.26 8.46L7.9 6.02L6.46 3.53L5.81 2.5L5.64 1.88L5.62 1.78L5.6 1.69L5.58 1.6L5.57 1.51L5.56 1.43L5.55 1.34L5.54 1.24L5.54 1.15L6.29 0.13L6.7 0L7.7 0.13L8.11 0.5L8.73 1.91L9.74 4.14L11.29 7.17L11.74 8.07L11.99 8.9L12.08 9.16Z', ox: 10.74, oy: 8.98 },  // tip 244°
];

/**
 * 每个触点相对前一个的起拍间隔；一整圈 = 12 × 85ms ≈ 1.0s（转速旋钮就是
 * 这个数：70 被判"太快"、100 被判"太慢"，85 是二分出来的）。
 *
 * 脉冲三段 = 挤压 → 蓄压 → 释放（用户点名的感觉，三版定案）：
 *   收（0→11%）：减速压进去（ease-out 形）—— 越压阻力越大，不是砸下去；
 *   憋（11→16%）：在 0.74 停一拍 —— 压力握在手里的那一瞬；
 *   放（16→34%）：back-out 回弹缓动一口气释放，冲过 1 一点再落定 ——
 *     过冲由**曲线**自己完成，不是关键帧硬跳。
 * ⚠️ 这一段不能用 step-end：定格跳帧表达不了弹性（二版失败的根因 ——
 * 三四个瞬移帧看起来是抖动不是弹簧）。描线/显影那些照旧定格。
 */
const RAY_STEP_MS = 85;

/**
 * 所有身体共用的一份 keyframes（SpriteSketchLayer 把它和自己的手写字动画拼在一起注入）。
 *
 * 鲸的四条常态周期 2.8 / 5.2 / 3.6 / 7.2s **故意不整除**：整除的话几秒就看出循环点，
 * 那是"在放动画"不是"活着"。
 *
 * 潜的时间轴（seaDive，全长 DIVE_MS）是**逐帧量出来的**，百分比一个都别凭感觉改：
 *   0→30%    下沉，先慢后快再缓 —— 阻力随深度增
 *   30→45%   折返冲回原位（浮力加速）
 *   45→54%   冲出原位到顶，减速
 *   54→60%   重力接手，落回
 *   60→100%  落回之后**被阻力吃住、再被托起**的衰减振荡：1.7 → -1.1 → 0.65 → 0，
 *            每个折返都是 ease-in-out（两头都圆）。⚠️ 不能配成"进去 ease-in / 出来 ease-out"，
 *            那是**弹球**（触底速度硬反向、位置曲线是尖的 V），跟被托起来是两种东西 ——
 *            浮力≈弹簧：周期基本不变、只有振幅衰减；弹球是振幅和周期一起缩。
 * 折返点上位移必然归零，所以那几拍**靠姿态继续走**（鼻子先抬后落）——
 * 21 对相邻帧里只剩 1 对位移 ≤1px（最深那一拍，本来就该在那儿停住）。
 *
 * ⚠️ 画面上**没有水**（用户 08-21 拍板砍掉水纹）。曲线仍按浮力那套推，因为那是它读起来
 * 像"被托上来"而不是"撞回来"的原因 —— 水看不见，物理还在。
 */
export const FIGURE_KEYFRAMES = `
  @keyframes ndSketchDraw { to { stroke-dashoffset: 0; } }
  @keyframes ndSketchFill { to { opacity: 0.94; } }
  @keyframes ndRayPulse {
    0%   { transform: scale(1);    animation-timing-function: cubic-bezier(0.2, 0.65, 0.45, 1); }
    11%  { transform: scale(0.74); animation-timing-function: linear; }
    16%  { transform: scale(0.74); animation-timing-function: cubic-bezier(0.3, 2.2, 0.4, 1); }
    34%  { transform: scale(1); }
    100% { transform: scale(1); }
  }
  @keyframes ndCoreBreath { 0% { transform: scale(1); } 50% { transform: scale(1.1); } 100% { transform: scale(1); } }
  @keyframes ndSeaBob {
    0%   { transform: translateY(0) rotate(0); }
    25%  { transform: translateY(-0.42px) rotate(-2.1deg); }
    50%  { transform: translateY(0.08px) rotate(0); }
    75%  { transform: translateY(0.42px) rotate(2.1deg); }
    100% { transform: translateY(0) rotate(0); }
  }
  @keyframes ndSeaTail {
    0%, 56% { transform: skewY(0); }
    64%  { transform: skewY(-2.4deg); }
    72%  { transform: skewY(2.2deg); }
    80%  { transform: skewY(-1deg); }
    88%, 100% { transform: skewY(0); }
  }
  @keyframes ndSeaBreath { 0% { transform: scale(1); } 50% { transform: scale(1.028); } 100% { transform: scale(1); } }
  /**
   * GLM 三笔顺序提亮（09-08 站主选的 v2 ① 那版）。
   *
   * ⚠️ 这是**只给精灵用的**。同一个动法放进 picker 行会出事：半透明在这套界面里
   * 已经有含义了 ——「这一项不可用」，而 picker 马上要放可用性状态色点，两者会抢同一句话。
   * 站主 09-08 明确划了范围：精灵上动，picker 不动。
   *
   * 底 0.34 是量过的：整枚平均灰度比闲态淡 +0.243，比其余变体高一个数量级。
   * 在纸面精灵上这是"轮流被点到"，在一行模型名旁边就是"这行是灰的"——同一个动画，
   * 两个语境两种读法，所以范围必须钉死。
   */
  @keyframes ndGlmLit {
    0%, 100% { opacity: 0.34; }
    12%      { opacity: 1; }
    38%      { opacity: 0.34; }
  }
  @keyframes ndSeaSpout {
    0%   { stroke-dashoffset: 1; opacity: 0; }
    3%   { opacity: 0.9; }
    9%   { stroke-dashoffset: 0; opacity: 0.9; }
    15%  { opacity: 0; }
    100% { opacity: 0; stroke-dashoffset: 1; }
  }
  @keyframes ndSeaDive {
    0%   { transform: translateY(0) rotate(0);             animation-timing-function: cubic-bezier(.4,.08,.5,1); }
    30%  { transform: translateY(5.6px) rotate(7deg);      animation-timing-function: cubic-bezier(.42,0,.62,.65); }
    45%  { transform: translateY(0) rotate(-1.5deg);       animation-timing-function: cubic-bezier(.25,.55,.5,1); }
    54%  { transform: translateY(-1.7px) rotate(-4.2deg);  animation-timing-function: cubic-bezier(.45,0,.85,.5); }
    60%  { transform: translateY(0) rotate(-1.8deg);       animation-timing-function: cubic-bezier(.15,.5,.35,1); }
    69%  { transform: translateY(1.7px) rotate(2.8deg);    animation-timing-function: ease-in-out; }
    80%  { transform: translateY(-1.1px) rotate(-1.9deg);  animation-timing-function: ease-in-out; }
    90%  { transform: translateY(0.65px) rotate(1.2deg);   animation-timing-function: ease-in-out; }
    100% { transform: translateY(0) rotate(0); }
  }
  @keyframes ndOcFill {
    0%   { transform: scaleY(0.28); }
    45%  { transform: scaleY(1); }
    70%  { transform: scaleY(1); }
    100% { transform: scaleY(0.28); }
  }
`;

/**
 * 出场那两笔的样式：铅笔稿沿着 path 描一遍，墨色再从底下显影出来。
 * 做成样式而不是组件 —— 鲸的墨色路径要住在会动的那几层里面（不然静态一份 + 动画一份
 * 会重叠成双影：静止时看不出来，一动就露馅）。
 */
const PENCIL_IN = { strokeDasharray: 1, strokeDashoffset: 1, animation: `ndSketchDraw ${MARK_DRAW_MS}ms steps(14, end) forwards` };
const INK_IN = { opacity: 0, animation: 'ndSketchFill 420ms steps(6, end) 640ms forwards' };
/** 铅笔稿的画法（三种身体同一支笔） */
const PENCIL_STROKE = { fill: 'none', stroke: PAPER.ink2, strokeWidth: 0.55, strokeLinecap: 'round', strokeLinejoin: 'round' };

/** 画幅：按**这枚标的高度**折算，宽度随外框比例放开 */
function Frame({ vb, size, style, children }) {
  const [x, y, w, h] = vb;
  return (
    <svg
      width={Math.round((size * w) / h * 10) / 10} height={size} viewBox={`${x} ${y} ${w} ${h}`}
      aria-hidden="true" style={{ display: 'block', overflow: 'visible', ...style }}
    >
      {children}
    </svg>
  );
}

/** 一枚标原样描出来（星芒闲时、gemini/qwen 全时用这个） */
function InkSketch({ mark, size, style }) {
  const fillRule = mark.evenodd ? 'evenodd' : undefined;
  return (
    <Frame vb={mark.vb} size={size} style={style}>
      {mark.paths.map((p, i) => <path key={`pen${i}`} d={p.d} fillRule={fillRule} pathLength="1" {...PENCIL_STROKE} style={PENCIL_IN} />)}
      {mark.paths.map((p, i) => <path key={i} d={p.d} fillRule={fillRule} fill={p.tint || mark.color} style={INK_IN} />)}
    </Frame>
  );
}

/**
 * 干活时的星芒：**触点自己**顺时针逐个挤压-释放，中心毂随行波呼吸。
 * 同色描边 0.3：独立形状在共享边上各自抗锯齿，拼缝会透出底色成一圈细线（480px 实测可见）——
 * 描边让相邻形状彼此搭 0.15，缝就没了；顺带把尖角磨圆一点，更像笔画的。
 */
function ClaudeSpinner({ size }) {
  const period = RAYS.length * RAY_STEP_MS;
  const ink = { fill: CLAUDE_BRAND, stroke: CLAUDE_BRAND, strokeWidth: 0.3, strokeLinejoin: 'round', strokeLinecap: 'round' };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      style={{ display: 'block', flexShrink: 0, overflow: 'visible', opacity: 0.95 }}>
      {/* 中心毂只向外鼓（scale ≥ 1）—— 触点的根都钉在毂缘上，向内缩就把接缝拉开了 */}
      <path d={HUB} {...ink} style={{ transformOrigin: '12px 12px', transformBox: 'view-box', animation: `ndCoreBreath ${period}ms ease-in-out infinite` }} />
      {RAYS.map((r, i) => (
        <path
          key={i} d={r.d} {...ink}
          style={{
            // 每根绕自己的根挤压（不是绕图心）—— "往里挤"的方向就是各自的轴向
            transformOrigin: `${r.ox}px ${r.oy}px`, transformBox: 'view-box',
            animation: `ndRayPulse ${period}ms linear infinite`,
            animationDelay: `${i * RAY_STEP_MS - period}ms`,
          }}
        />
      ))}
    </svg>
  );
}

/** 鲸喷的那口气（三笔铅笔，描出来再散）。坐标在鲸背上方，所以鲸的画幅要比标的外框高一截 */
const SPOUT = [
  { d: 'M9.6 3.3 C9.2 2.2 9.3 1.4 9.9 0.7', w: 0.5, delay: 0 },
  { d: 'M10.8 3.1 C11.0 2.0 11.5 1.4 12.3 1.0', w: 0.45, delay: 90 },
  { d: 'M8.6 3.6 C7.9 2.8 7.5 2.2 7.4 1.5', w: 0.4, delay: 170 },
];
/**
 * 鲸的画幅：上边留到 0.2（喷气在鲸背上方），下边到 21.7 —— 比鲸本身（17.66 高）多出一截。
 * 所以渲染时要**先把画幅放大回去**，鲸自己才正好是 size 高：三家标一律按高度对齐，
 * 不然鲸会比星芒矮一圈（第一版就是这么矮了 18%）。
 */
const WHALE_VB = [0, 0.2, 24, 21.5];
const WHALE_SCALE = WHALE_VB[3] / 17.66;
/**
 * 视觉配重：鲸是横的，等高摆在星芒旁边会显得大一圈（宽度多 36%）。收 12% 之后
 * 三种身体在画布上才是同一个分量 —— 图形对齐看数字，视觉对齐得看眼睛。
 */
const WHALE_OPTICAL = 0.88;

/**
 * 潜的节拍器：干活起手潜一次，之后每隔 DIVE_GAP 里的一个随机数再潜。
 * 随机是有意的 —— 固定间隔几轮就被认出来，那就成了秒表不是生物。
 */
function useDiveTimer(active) {
  const [diving, setDiving] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    if (!active) { setDiving(false); return undefined; }
    let alive = true;
    const stop = () => { if (timer.current) clearTimeout(timer.current); };
    const schedule = (delay) => {
      stop();
      timer.current = setTimeout(() => {
        if (!alive) return;
        setDiving(true);
        timer.current = setTimeout(() => {
          if (!alive) return;
          setDiving(false);
          schedule(DIVE_GAP[0] + Math.random() * (DIVE_GAP[1] - DIVE_GAP[0]));
        }, DIVE_MS);
      }, delay);
    };
    schedule(DIVE_FIRST_MS);
    return () => { alive = false; stop(); };
  }, [active]);
  return diving;
}

/**
 * 鲸。闲时只呼吸（活物不该定住），干活时加上起伏/甩尾/喷气，并且每隔一会儿潜一次。
 * 四条周期不整除，叠起来看不出循环点。
 */
function WhaleFigure({ size, active }) {
  const diving = useDiveTimer(active);
  const anim = (v) => (active ? v : undefined);
  const whale = MARKS.deepseek.paths[0].d;
  const layer = (origin, animation) => ({ transformOrigin: origin, transformBox: 'view-box', animation });
  return (
    // ⚠️ 墨色鲸只有这一份，而且住在最里层：出场描线、起伏、甩尾、呼吸、潜全都作用在它身上。
    // 外面再画一份静态的会成双影（静止时严丝合缝，一动就露出来）
    <Frame vb={WHALE_VB} size={size * WHALE_SCALE * WHALE_OPTICAL}>
      <g style={layer('12px 12px', diving ? `ndSeaDive ${DIVE_MS}ms 1 both` : undefined)}>
        <g style={layer('12px 12px', anim('ndSeaBob 2800ms ease-in-out infinite'))}>
          <g style={layer('1.5px 12px', anim('ndSeaTail 5200ms ease-in-out infinite'))}>
            <g style={layer('12px 13px', 'ndSeaBreath 3600ms ease-in-out infinite')}>
              <path d={whale} pathLength="1" {...PENCIL_STROKE} style={PENCIL_IN} />
              <path d={whale} fill={MARKS.deepseek.color} style={INK_IN} />
              {active && SPOUT.map((s, i) => (
                <path
                  key={i} d={s.d} pathLength="1" fill="none" stroke={MARKS.deepseek.color}
                  strokeWidth={s.w} strokeLinecap="round"
                  style={{ strokeDasharray: 1, strokeDashoffset: 1, opacity: 0, animation: 'ndSeaSpout 7200ms ease-out infinite', animationDelay: `${s.delay}ms` }}
                />
              ))}
            </g>
          </g>
        </g>
      </g>
    </Frame>
  );
}

/**
 * OpenCode 方块（Ox 这类隐身免费行）。干活时下半截填充块像终端光标一样涨落 ——
 * 零新素材，和方块标本来的语义一致。
 */
function OpenCodeFigure({ size, active }) {
  const [frame, block] = MARKS.opencode.paths;
  return (
    <Frame vb={MARKS.opencode.vb} size={size}>
      <path d={frame.d} fillRule="evenodd" pathLength="1" {...PENCIL_STROKE} style={PENCIL_IN} />
      <path d={block.d} pathLength="1" {...PENCIL_STROKE} style={PENCIL_IN} />
      <path d={frame.d} fillRule="evenodd" fill={MARKS.opencode.color} style={INK_IN} />
      {/* 填充块只画一份：干活时它自己涨落，闲时就是满的。两份叠着的话涨落时会露出底下那份 */}
      <path
        d={block.d} fill={block.tint}
        style={active
          ? { transformOrigin: '12px 16.5px', transformBox: 'view-box', animation: 'ndOcFill 1800ms ease-in-out infinite' }
          : INK_IN}
      />
    </Frame>
  );
}

/**
 * 干活时的 GLM：Z 的三笔**顺序提亮**（上横 → 斜杠 → 下横），闲时静止。
 *
 * ⭐ 三笔的墨量是 12.9 / 75.3 / 13.5（视图单位²）—— 斜杠一个人占 74%。所以错拍
 * 不是等分的：`STEP` 走完两拍就到斜杠，读起来是"小 → 大 → 小"，跟 Z 的笔顺一致。
 *
 * ⛔ 墨色形状只画一份（跟 OpenCode 那枚同一条纪律）：静态一份 + 动画一份叠着，
 * 静止时严丝合缝，一动就露双影。
 */
function GlmFigure({ size, active }) {
  const mark = MARKS.glm;
  return (
    <Frame vb={mark.vb} size={size}>
      {GLM_STROKES.map((d, i) => (
        <path key={`pen${i}`} d={d} pathLength="1" {...PENCIL_STROKE} style={PENCIL_IN} />
      ))}
      {GLM_STROKES.map((d, i) => (
        <path
          key={i} d={d} fill={mark.color}
          style={active
            ? { animation: `ndGlmLit ${GLM_PERIOD}ms linear infinite`, animationDelay: `${i * GLM_STEP - GLM_PERIOD}ms` }
            : INK_IN}
        />
      ))}
    </Frame>
  );
}

/**
 * 精灵的身体。`brand` 认不出时不画（服务端有断言兜着，这里只可能是前端比服务端旧）——
 * 宁可空着也不画错一家的标。
 *
 * onClick 给了就可点（对话通道）：按下先来一记"收缩回弹"（Web Animations API 直接在节点上放动画 ——
 * CSS 类名重触发要靠 remount，会把描线动画一起重播）。动作放在 pointerdown：画布容器的手势会
 * setPointerCapture，click 根本不生成（BindingLayer 2026-08-14 踩过的同一个坑）。
 *
 * onDragMove/onDragEnd 给了就可拖（08-24 用户报"精灵挪不走"）：pointerdown 先
 * 观望，位移 >5px 判成拖（逐帧回报屏幕位移），松手回 onDragEnd；没动过才算
 * 点击 —— 这时 onClick 从 pointerdown 挪到 pointerup 触发（自己捕获了指针，
 * 不再受画布抢捕获那个坑的约束）。
 */
export function SpriteFigure({ brand, size = 44, active = false, onClick, onDragMove, onDragEnd }) {
  const wrapRef = useRef(null);
  const mark = MARKS[brand];
  const pressable = typeof onClick === 'function' || typeof onDragMove === 'function';
  const pop = () => {
    try {
      wrapRef.current?.animate([
        { transform: 'scale(1)' }, { transform: 'scale(0.72)', offset: 0.35 },
        { transform: 'scale(1.1)', offset: 0.7 }, { transform: 'scale(1)' },
      ], { duration: 260, easing: 'ease' });
    } catch { /* 老浏览器没有 WAAPI：没动画也得能点 */ }
  };
  const press = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (typeof onDragMove !== 'function') {   // 只可点：维持原有"pointerdown 即触发"
      pop();
      onClick?.(e);
      return;
    }
    const el = wrapRef.current;
    const sx = e.clientX; const sy = e.clientY;
    let moved = false;
    el?.setPointerCapture?.(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - sx; const dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (moved) onDragMove(dx, dy);
    };
    const onUp = (ev) => {
      el?.removeEventListener('pointermove', onMove);
      el?.removeEventListener('pointerup', onUp);
      el?.removeEventListener('pointercancel', onUp);
      if (moved) onDragEnd?.();
      else { pop(); onClick?.(ev); }
    };
    el?.addEventListener('pointermove', onMove);
    el?.addEventListener('pointerup', onUp);
    el?.addEventListener('pointercancel', onUp);
  };
  if (!mark) return null;
  let body;
  if (brand === 'claude') body = active ? <ClaudeSpinner size={size} /> : <InkSketch mark={mark} size={size} />;
  else if (brand === 'deepseek') body = <WhaleFigure size={size} active={active} />;
  else if (brand === 'opencode') body = <OpenCodeFigure size={size} active={active} />;
  else if (brand === 'glm') body = <GlmFigure size={size} active={active} />;
  // gemini / qwen 没有专门的动法：出场画法一样，干活时整体轻微呼吸
  else body = <InkSketch mark={mark} size={size} style={active ? { animation: 'ndSeaBreath 2600ms ease-in-out infinite', transformOrigin: 'center' } : undefined} />;
  return (
    <span
      ref={wrapRef}
      onPointerDown={pressable ? press : undefined}
      title={pressable ? (typeof onDragMove === 'function' ? '写一句给它 · 拖着可以挪走' : '写一句给它') : undefined}
      style={{
        display: 'block', flexShrink: 0,
        // 命中垫：镜头拉远只剩十几像素，裸命中区点不中很沮丧
        padding: 8, margin: -8,
        pointerEvents: pressable ? 'auto' : 'none',
        cursor: pressable ? (typeof onDragMove === 'function' ? 'grab' : 'pointer') : undefined,
        touchAction: pressable ? 'none' : undefined,
      }}
    >
      {body}
    </span>
  );
}

/** 这枚身体占多宽（SpriteSketch 排版要预留）—— 各家标的外框比例不同，鲸最宽 */
export function figureWidth(brand, size) {
  const mark = MARKS[brand];
  if (!mark) return size;
  if (brand === 'deepseek') return Math.round((size * WHALE_SCALE * WHALE_OPTICAL * WHALE_VB[2]) / WHALE_VB[3]);
  const [, , w, h] = mark.vb;
  return Math.round((size * w) / h);
}
