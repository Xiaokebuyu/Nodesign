/**
 * 登录墙的**材质词汇** —— 全场景共用的那一半 CSS（2026-08-17 从 AuthGate 拆出）。
 *
 * 切口是用户当初定的那句话：**能共用的是材质，不是坐标**。所以这里只有
 * 「一张纸长什么样」——板面、纸基座与三档景深、纸材（便签/方格纸/终端墨版/
 * 牛皮卷宗/小票/黄笺/索引卡/描图纸）、固定件（图钉/回形针/订书钉）、瑕疵
 * （折痕/褶皱/折角/装订孔）、编号红圈、线索线、板上的字、登记卡。
 *
 * **每张纸摆在哪、上面写什么，不在这儿** —— 那是一套构图的事，住在
 * `scenes/<id>.jsx` 里，跟着场景一起换。想加一面新墙就加一个场景文件，
 * 不用动这里。
 *
 * 为什么不把纸也抽成「纸材类 + 位置数据」那种统一描述：试过就知道，每张纸
 * 的内部构造（线框图的方块、终端的行、卷宗的签和装订孔）都是为那一处专门
 * 画的，硬塞进统一 schema 只会让每个场景都在跟 schema 打架。墙是**设计**
 * 不是数据。
 */
import { PAPER_VARS } from '../../lib/paper.js';
import { DESIGN_W, DESIGN_H } from './geometry.js';

/**
 * 一套墙的节拍（毫秒）。**CSS 和 JS 必须用同一份**：轮播那边要知道「摘完了
 * 没有」才能换场景，写两处就会出现纸还没摘完新场景已经钉上来。
 *
 * ## 用户 2026-08-17 定的节奏：一轮 10 秒，一直在动
 *
 * 原话「先慢慢展开，然后中速收起再换另一套展开，持续不断」。所以不是"静止
 * 十几秒 + 眨眼切换"，而是**展开本身就是内容**：
 *
 *     慢慢钉上去 5.5s  →  站着 1.4s  →  中速摘下来 3.1s  →  下一套
 *
 * `step*` 是每张纸之间错开的一格。二十张纸 × 240ms = 展开要 4.8 秒才轮到最后
 * 一张 —— 这就是"慢慢"的来源，不是把单张的动画时长拉长（那只会变成慢动作的
 * 淡入，不是一张张摆上去）。
 *
 * ⚠️ **`still` 是这三个数里唯一该动的旋钮。** 墙原本是顺着红线读故事的，10 秒
 * 里只有 1.4 秒完整站着，读不完一遍是必然的。觉得该给读的时间，把 `still` 调大
 * 即可，别去改 step —— 那会连带把"一张张摆上去"的手感改掉。
 */
/**
 * 一格胶片 = FRAME 毫秒。**整面墙的观感就是这一个数。**
 *
 *   16ms ≈ 60fps    完全平滑
 *   32ms ≈ 30fps    单张卡的动作够顺（现在用的）
 *   80ms ≈ 12.5fps  定格经典的"拍两格"
 *
 * ⭐ **定格感不该由这个数来扛。** 用户 2026-08-28 拍板的分工是：
 *   单张卡自己的动作 → 30fps，要顺
 *   卡与卡之间的间隔（stepIn / stepOut）→ 留大，一张一张往上钉，定格感在这儿
 * 一整面墙同时以 12.5fps 抖，读起来是"坏了"；一张一张按节拍出现、每张自己动作
 * 干净，读起来才是"有人在钉"。
 *
 * 下面所有时长和延迟都是 FRAME 的整数倍（由 wall-motion.lint.test.js 逐条对账）。
 *
 * 2026-08-28 的历史：先是 80ms 定格。
 *
 * ⭐ 用户先报「帧率太低、观感不好」。量下来问题**不是慢**：录屏逐帧哈希
 * 显示静止时画面每 33ms 就变一次（那是 sway 的亚像素抖动，每帧转 0.017deg ≈
 * 0.09px，肉眼根本看不见），而进出场时画面一停就是 100-500ms。也就是说整面墙上
 * 同时跑着两种节拍，被看见的只有粗的那一种，于是它读起来像"坏了"而不像"手做的"。
 *
 * 定格动画之所以成立，是**整个画面按同一个快门走**。所以这里立一个帧钟：
 * 下面每一个时长和每一处延迟都必须是 FRAME 的整数倍，连常驻的风吹纸摆也钉在
 * 同一格上（由 wall-motion.lint.test.js 逐个数对）。
 *
 * 但 12.5fps 一刀切下去，连单张卡自己的动作都在抖，于是改成 32ms + 拉大间隔。
 * 定格的三样底子都留着：钉上去过一点再坐回、摘下来先揭一下、纸与纸错开。
 */
export const FRAME = 32;

/**
 * 一段关键帧区间要写几格。
 *
 * ⛔⛔ **`steps()` 是按「每两个关键帧之间」算的，不是按整条动画算的。**
 * 08-28 我给 ndw-pin-in 加了中间帧做"过一点再回来"，格数就被悄悄乘了 3 ——
 * CSS 没报错、格数字面上还写着 6，实测画面每 26ms 就变一次（≈38fps，比改之前
 * 还平滑，正好跟"要更像定格"反着来）。是 getAnimations() + 两张 33ms 截图逐字节
 * 比才逮住的。
 *
 * 而且 `jump-none` 下一段区间取 n 个值（含首尾），所以**变化次数是 n-1**。
 * 于是：一段区间 d 毫秒要每 FRAME 跳一格 → n = d / FRAME + 1。
 * 关键帧必须等距，不然每段的格子长短不一，还是脱拍。
 * 由 wall-motion.lint.test.js 按「关键帧条数 × steps 数 × 时长」三者对账。
 */
export const stepsFor = (intervalMs) => intervalMs / FRAME + 1;

export const MOTION = {
  // ⭐ 一张卡自己的动作走 15 格（够顺）；**张与张之间隔 256ms**（8 格）——
  //    定格感全在这个间隔上：一张钉稳了下一张才上手，不是一整面墙一起抖。
  enter: 480, stepIn: 256,
  leave: 480, stepOut: 160,    // 摘的时候快一点（手往下捋），错开 5 格
  threadIn: 704,               // 红线画出来（等所有纸钉完才开始）
  inkOut: 320, boardOut: 384,  // 收起时：线先擦、板上的墨最后淡
  still: 1440,                 // 钉完之后站着不动的那一拍
  inkIn: 384, inkStep: 96,     // 板上的墨：单个的时长 / 彼此错开
  handStep: 160,               // 手写标签彼此错开
  sway: 6400, swayStep: 576,   // 风吹纸摆一个来回 / 每张纸错开
};

/**
 * 进场 / 退场各要多久 —— 轮播的定时器按它算，`n` 是这一套有几张纸。
 *
 * ⚠️ 进场的尾巴不是最后一张纸，是**红线那一拨**：它要等所有纸钉完才开始画。
 * 按纸算完就摘 class 的话，线会在半路被掐掉直接跳到全黑。
 * ⚠️ 退场的尾巴也不是纸，是**板上的墨**：涂鸦画在板面上、纸压在它们之上，
 * 所以纸摘光了它们才淡（正好是进场顺序的倒放）。
 */
export const enterMs = (n) => n * MOTION.stepIn + MOTION.threadIn;
export const leaveMs = (n) => Math.max(
  MOTION.inkOut + Math.max(0, n - 1) * MOTION.stepOut + MOTION.leave,
  n * MOTION.stepOut + MOTION.boardOut,
);

export const WALL_CSS = `
.ndw {
  ${PAPER_VARS}
  position: fixed; inset: 0; overflow: hidden;
  font-family: var(--kai); color: var(--ink);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(ellipse 120% 90% at 50% 118%, rgba(80,62,40,0.08), transparent 55%),
    linear-gradient(105deg, transparent 50%, rgba(255,244,210,0.30) 51% 58%, transparent 59%, transparent 64%, rgba(255,244,210,0.22) 66% 70%, transparent 71%),
    radial-gradient(ellipse 90% 70% at 80% 4%, rgba(255,210,130,0.22), transparent 62%),
    /* 大块斑驳：板子不是一块匀色板 */
    radial-gradient(ellipse 46% 40% at 16% 26%, rgba(122,96,56,0.055), transparent 72%),
    radial-gradient(ellipse 38% 46% at 72% 74%, rgba(122,96,56,0.05), transparent 74%),
    radial-gradient(ellipse 30% 28% at 94% 20%, rgba(255,246,218,0.45), transparent 72%),
    radial-gradient(ellipse 26% 30% at 4% 84%, rgba(122,96,56,0.045), transparent 72%),
    radial-gradient(ellipse 40% 30% at 10% 66%, rgba(93,74,44,0.045), transparent 70%),
    radial-gradient(ellipse 34% 26% at 90% 40%, rgba(93,74,44,0.04), transparent 70%),
    var(--grain),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.03) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.03) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.022) 0 1px, transparent 1px 140px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.022) 0 1px, transparent 1px 140px),
    var(--wall);
}
/* 织纹 + 旧钉眼：三层不同周期错开，看不出重复 */
.ndw::before {
  content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(circle at 37px 51px, rgba(72,55,32,0.17) 0 1.1px, transparent 1.7px),
    radial-gradient(circle at 119px 23px, rgba(72,55,32,0.14) 0 1px, transparent 1.6px),
    radial-gradient(circle at 61px 137px, rgba(72,55,32,0.12) 0 1.2px, transparent 1.8px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.019) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.015) 0 1px, transparent 1px 3px);
  background-size: 163px 211px, 271px 149px, 197px 313px, auto, auto;
}
/* 旧痕：这儿以前挂过东西，取下来了 */
.ndw-ghost { position: absolute; z-index: 0; pointer-events: none;
  background: rgba(255,252,240,0.22); border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(43,33,23,0.02), 0 0 12px 7px rgba(255,252,240,0.1); }
.ndw-ghost::after { content: ''; position: absolute; left: 50%; top: 5px; width: 3px; height: 3px;
  margin-left: -1.5px; border-radius: 50%; background: rgba(72,55,32,0.26); }
.ndw * { margin: 0; padding: 0; box-sizing: border-box; }

/* 整面墙 = 一张 1500x800 的设计稿，顶边对齐缩放 */
.ndw-stage {
  position: absolute; z-index: 1; left: 50%; top: 0;
  margin-left: -${DESIGN_W / 2}px;
  width: ${DESIGN_W}px; height: ${DESIGN_H}px;
  transform: scale(var(--s, 1));
  transform-origin: top center;
}
/* 随手涂鸦：直接画在板子上，压在所有纸底下。是墙的一部分，不是挂件。
   素材是真 alpha 不是白底 —— 涂鸦在 .ndw-stage 里，stage 的 transform 开了新的
   层叠上下文，mix-blend-mode 够不着画在根节点上的板面，白底会原样糊一块上去。
   每个涂鸦都自带一句手写，字和画是同一次生成的（见 DOODLES 注释） */
.ndw .doodle { position: absolute; z-index: 1; pointer-events: none;
  opacity: 0.55; display: block; }

/* ===== 纸 =====
   层次靠三样：①阴影分三档且带光向（右上打光→影子一律偏左下，全站同一个方向）
   ②纸叠纸（背后垫一张露边的空纸）③底边起拱（单钉吊着的纸会往外弯） */
.ndw .paper { position: absolute; background-color: var(--paper); background-image: var(--grain);
  box-shadow: -1px 2px 3px rgba(93,74,44,0.15), -3px 6px 12px rgba(93,74,44,0.15);
  transform: rotate(var(--rot, 0deg)); transform-origin: 50% 7px; z-index: 2; }
/* 最远：贴得最平，影子小而紧，再退半档空气感 */
.ndw .paper.z0 { box-shadow: -1px 1px 2px rgba(93,74,44,0.14), -1px 3px 5px rgba(93,74,44,0.09);
  filter: brightness(0.976) saturate(0.93); }
/* 最近：影子大而散 */
.ndw .paper.z2 { box-shadow: -2px 3px 4px rgba(93,74,44,0.18), -6px 13px 26px rgba(93,74,44,0.22); }
/* 垫在后面那张空纸：只露一道边 */
.ndw .pstack { z-index: 1; background-color: #F8F3E7;
  box-shadow: -1px 2px 4px rgba(93,74,44,0.13), -2px 5px 9px rgba(93,74,44,0.11); }
/* 底边起拱：单钉吊着的纸，下缘往外弯，中间背光 */
.ndw .bow { position: absolute; left: 0; right: 0; bottom: 0; height: 32%; z-index: 3;
  pointer-events: none;
  background: radial-gradient(130% 100% at 50% 112%, rgba(43,33,23,0.07), transparent 62%); }
/* 风吹纸摆也走帧钟（2026-08-28）。
   原来每张纸自带一个 5.3-8.2s 不等的周期、平滑 ease-in-out —— 那是墙上唯一一个
   不按快门走的东西。它本身看不见（每格转 0.017deg），但它让"整面墙同一个快门"
   这件事不成立，而且每秒白白重合成几十次。
   现在周期统一，相位按第几张纸错开（--i 由 Scene.jsx 在运行时按 DOM 顺序发），
   于是 40 个手写的 --dur/--delay 一起退休。 */
/* ⛔ 别用 「alternate」 把来回省成半程（⚠️ 这段 CSS 是 JS 模板字符串，注释里
   一个反引号就把整个文件炸成 SyntaxError —— 08-28 我踩了三次）。实测（rAF 采样每张纸的 transform）：反向那
   半程的 jump-none 台阶是**镜像**的，跟正向差半格 —— 于是十五张纸分裂成两套错开
   的格子，"整面墙同一个快门"当场不成立（量到全墙每 17ms 就有人在跳）。
   老老实实写三帧三角波：两段各 40 格，一个来回 80 格，所有纸共用一套格子。 */
@keyframes ndw-sway {
  0%, 100% { transform: rotate(calc(var(--rot, 0deg) - 0.32deg)); }
  50%      { transform: rotate(calc(var(--rot, 0deg) + 0.32deg)); }
}
.ndw .sway {
  animation: ndw-sway ${MOTION.sway}ms steps(${stepsFor(MOTION.sway / 2)}, jump-none) infinite;
  animation-delay: calc(var(--i, 0) * -${MOTION.swayStep}ms);
}
@media (prefers-reduced-motion: reduce) { .ndw .sway { animation: none; } }

/* 固定件：一张纸一种，别都用钉 */
.ndw .pin { position: absolute; top: 6px; left: 50%; width: 9px; height: 9px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); transform: translateX(-50%); z-index: 6; }
.ndw .pin.r { background: radial-gradient(circle at 35% 30%, #b4544a, #7d241c 65%); }
.ndw .clip { position: absolute; top: -13px; left: var(--cx, 22%); width: 17px; z-index: 6;
  filter: drop-shadow(-1px 2px 2px rgba(43,33,23,0.32)); }
.ndw .staple { position: absolute; top: 9px; left: var(--cx, 12px); width: 15px; height: 4px; z-index: 6;
  transform: rotate(-28deg); background: linear-gradient(180deg, #b9b2a4, #6f6759);
  box-shadow: -1px 1.5px 1.5px rgba(43,33,23,0.45); }

/* 瑕疵 */
.ndw .crease::before { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background: linear-gradient(112deg, transparent 47.6%, rgba(43,33,23,0.045) 49.1%, rgba(255,255,255,0.22) 49.9%, transparent 51.2%); }
.ndw .crease-h::before { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background: linear-gradient(178deg, transparent 48%, rgba(43,33,23,0.05) 49.6%, rgba(255,255,255,0.2) 50.4%, transparent 52%); }
.ndw .wrinkle::after { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background:
    linear-gradient(99deg, transparent 20%, rgba(43,33,23,0.035) 30%, transparent 40%),
    linear-gradient(84deg, transparent 62%, rgba(255,255,255,0.4) 70%, transparent 79%); }
.ndw .dog::after { content: ''; position: absolute; right: 0; bottom: 0; width: 24px; height: 24px;
  pointer-events: none; z-index: 4;
  background: linear-gradient(315deg, var(--wall) 48%, rgba(43,33,23,0.14) 50%, rgba(255,255,254,0.85) 58%, rgba(240,234,219,0.2) 72%, transparent 78%);
  box-shadow: -1px -1px 2px rgba(43,33,23,0.05); }
.ndw .holes { position: absolute; left: 8px; top: 17%; height: 66%; width: 8px; z-index: 4;
  background-image: radial-gradient(circle at 50% 50%, rgba(43,33,23,0.3) 0 3px, transparent 3.6px);
  background-size: 8px 33.33%; background-repeat: repeat-y; }

/* 编号：手写红圈，读顺序全靠它 */
.ndw .no { position: absolute; left: -15px; top: -14px; width: 30px; height: 30px; z-index: 7;
  display: grid; place-items: center; font: 700 13px var(--kai); color: var(--red); }
.ndw .no svg { position: absolute; inset: 0; width: 100%; height: 100%; }

/* 线索线 */
.ndw-thread { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 5; pointer-events: none; }
.ndw-thread path { fill: none; stroke: var(--red); stroke-width: 2; stroke-linecap: round; opacity: 0.72; }
.ndw-thread .soft { opacity: 0.5; stroke-width: 1.7; }
.ndw .hand { position: absolute; font: 13px var(--kai); color: var(--red); z-index: 7; opacity: 0.9;
  white-space: nowrap; }
.ndw .hand.p { color: var(--pencil); }

/* 直接写在板上的字：不带纸，压在所有纸之下 */
.ndw .wall { position: absolute; z-index: 1; pointer-events: none; color: rgba(122,111,92,0.92); }
.ndw .wall.lbl { font: 12px var(--kai); letter-spacing: 0.1em; color: rgba(130,119,99,0.88); }
.ndw .wall.blk { font: 12px var(--kai); line-height: 2.05; }
.ndw .wall.blk .t { display: block; font-weight: 700; font-size: 22px; letter-spacing: 0.1em;
  line-height: 1.3; color: rgba(104,93,76,0.95); }
.ndw .wall.blk .rule { display: block; width: 118px; height: 7px; margin: 5px 0 5px; }
.ndw .wall.blk .n { font-size: 15px; color: rgba(140,127,104,0.95); }
.ndw .when { display: block; margin-top: 7px; font: 9.5px var(--kai); letter-spacing: 0.08em;
  color: var(--pencil); }

/* 标题 */
/* ⚠️ max-width 用**设计稿的 px**不用百分比：整台戏是 1500x800 的稿按 --s 缩放的，
   这块地的右边界必须挡在场景第一张纸之前（约 520px）。百分比看着一样，但它是
   跟着舞台走的，改舞台宽度就会悄悄让标题伸进画里 —— 英文标题比中文长一半，
   08-28 之前就是这么压进右边那张照片的。 */
/* ⚠️ 这块地是**壳跟场景之间的约定**：三套场景在左上角都得给它让路。标题从一行
   变两行之后这块地长高了 ~50px，所以整体上提、行距收紧，把长出来的还回去一部分。
   改这里之前先跑一遍 wall-collide 探针（scratchpad），三套场景逐个对撞，别只看一张图。 */
.ndw-head { position: absolute; left: 3.5%; top: 3.4%; z-index: 3; max-width: 434px; }
.ndw-head .row { display: flex; align-items: baseline; gap: 13px; }
.ndw-logo { font: 700 24px var(--kai); letter-spacing: 0.06em; }
.ndw-anno { font: 11.5px var(--kai); color: var(--pencil); letter-spacing: 0.16em; }
.ndw-head h1 { margin-top: 13px; font-size: 30px; font-weight: 700; letter-spacing: 0.04em;
  line-height: 1.34; }
/* 一行一句，断行由文案自己决定，不交给宽度去猜。
   width:max-content 让手绘下划线只画到字尾；max-width:100% 是给长语言留的退路
   （宁可折行，也不许伸出这块地）。⛔ 别再写 white-space: nowrap —— 那正是英文
   标题压进场景照片的原因。 */
.ndw-head h1 .l { display: block; position: relative; width: max-content; max-width: 100%; }
.ndw-head h1 .u svg { position: absolute; left: -2%; width: 104%; height: 9px; bottom: -6px; }
.ndw-sub { margin-top: 11px; font-size: 14px; line-height: 1.7; color: var(--ink-2);
  /* ⚠️ 这一行必须**排得下一行**：标题占两行之后，副标再折行就会压到场景里
     那句手写标签上（三套场景在左上角都留了地，但留的是旧版那个高度）。 */
  white-space: nowrap; }

.ndw-card { position: absolute; right: 4%; top: 19%; width: 25%; padding: 34px 36px 26px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: -3px 4px 6px rgba(93,74,44,0.2), -9px 18px 34px rgba(93,74,44,0.26);
  transform: rotate(-0.4deg); transform-origin: 50% 8px; z-index: 8; }
.ndw-card h2 { font: 700 21px var(--kai); letter-spacing: 0.05em; }
.ndw-card .m { margin-top: 4px; font-size: 13px; color: var(--pencil); }
.ndw-tabs { margin-top: 19px; display: flex; gap: 24px; }
.ndw-tabs button { background: none; border: none; padding: 0 0 7px; cursor: pointer;
  font: 15px var(--kai); color: var(--pencil); position: relative; }
.ndw-tabs button.on { color: var(--ink); font-weight: 700; }
.ndw-tabs button svg { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 6px; }
.ndw-field { margin-top: 17px; }
.ndw-field label { display: block; font: 11px var(--kai); letter-spacing: 0.2em; color: var(--pencil); }
.ndw-field input { width: 100%; margin-top: 3px; padding: 8px 2px; font-size: 16px; font-family: var(--kai);
  background: transparent; border: none; border-bottom: 1.5px solid var(--hair); outline: none; color: var(--ink); }
.ndw-field input::placeholder { color: var(--pencil); }
.ndw-field input:focus { border-bottom-color: var(--ink); }
.ndw-err { margin-top: 12px; min-height: 17px; font: 12.5px var(--kai); color: var(--red); }
.ndw-card button.go { width: 100%; margin-top: 10px; padding: 12px 0; font: 700 16px var(--kai);
  letter-spacing: 0.35em; text-indent: 0.35em; background: var(--ink); color: #F5F0E4;
  border: none; border-radius: 3px; cursor: pointer; }
.ndw-card button.go:disabled { opacity: 0.55; cursor: default; }
.ndw-card .foot { margin-top: 13px; font: 12px var(--kai); color: var(--pencil); text-align: center; }
.ndw-stamp { position: absolute; right: 22px; top: 22px; padding: 4px 12px; border: 1.5px solid var(--red);
  color: var(--red); border-radius: 3px; font: 12px var(--kai); letter-spacing: 0.24em;
  text-indent: 0.24em; transform: rotate(3deg); opacity: 0.85; }

/* ===== 窄屏：整面墙收起，只留登记卡 ===== */
.ndw.narrow { display: grid; place-items: center; padding: 24px; }
.ndw.narrow .ndw-stage { display: none; }
/* 窄屏那张卡沿用 .ndw-card 的全部内部样式，只把定位和宽度改掉 */
.ndw-solo { position: relative; right: auto; top: auto;
  width: 100%; max-width: 360px; padding: 32px 30px 24px; }
.ndw-solo .brand { display: block; font: 700 20px var(--kai);
  letter-spacing: 0.06em; margin-bottom: 16px; }
/* ===== 定格切换（2026-08-17）=====
   用户的原话是「定格动画那种感觉」—— 不是淡入淡出、不是平滑位移，是一帧一帧
   跳的手做感。所以两条动画都走 「steps()」：浏览器只在那几个整数帧上采样，中间
   的插值全部被丢掉，看着就是有人一张一张把纸钉上去 / 摘下来。

   每张纸自带 「--i」（第几张），延迟 = i × 一格的时间 —— 手不可能同时钉八张。
   摘的时候顺序反过来（后钉的先摘），像倒放。 */
.ndw-scene { position: absolute; inset: 0; }
/* 钉上去有**过一点再回来**那一下（60% 那帧越过终点）：手一松纸会晃回位。
   6 格里第 4 格落在越冲的位置，最后一格坐回去 —— 这一下比"多给几格"有用得多，
   它是手做感的来源。opacity 在第 2 格就到位，不然第一格看着像闪。 */
@keyframes ndw-pin-in {
  0%       { opacity: 0; transform: rotate(calc(var(--rot, 0deg) + 3deg)) translate(6px, -14px); }
  33.3333% { opacity: 1; transform: rotate(calc(var(--rot, 0deg) + 1.6deg)) translate(3px, -6px); }
  66.6667% { opacity: 1; transform: rotate(calc(var(--rot, 0deg) - 0.9deg)) translate(-2px, 3px); }
  100%     { opacity: 1; transform: rotate(var(--rot, 0deg)) translate(0, 0); }
}
/* 摘下来先"揭"一下再掉：20% 那帧往回抬一点，像手先把纸从钉子上挑起来 */
@keyframes ndw-pin-out {
  0%       { opacity: 1; transform: rotate(var(--rot, 0deg)) translate(0, 0); }
  33.3333% { opacity: 1; transform: rotate(calc(var(--rot, 0deg) + 1.2deg)) translate(2px, -4px); }
  66.6667% { opacity: 0.6; transform: rotate(calc(var(--rot, 0deg) - 1.7deg)) translate(-4px, 6px); }
  100%     { opacity: 0; transform: rotate(calc(var(--rot, 0deg) - 4deg)) translate(-9px, 16px); }
}
/* 板上的字、涂鸦、线索线没有 --rot，单独一套（只跳明暗，不跳位置） */
@keyframes ndw-ink-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes ndw-ink-out { from { opacity: 1 } to { opacity: 0 } }

/* ⚠️ 这两条要压得过 「.ndw .sway」（那是常驻的风吹纸摆，也写在 animation 上）。
   压得过靠的是特异度：「.ndw-scene.enter .paper」 是 (0,3,0)，「.ndw .sway」 是
   (0,2,0)。别把它改成 「.ndw-scene .paper.enter」 那种写法 —— 一旦打平，两条
   动画抢同一个 transform，纸会在切换那一瞬瞬移。 */
.ndw-scene.enter .paper {
  animation: ndw-pin-in ${MOTION.enter}ms steps(${stepsFor(MOTION.enter / 3)}, jump-none) both;
  animation-delay: calc(var(--i, 0) * ${MOTION.stepIn}ms);
}
/* 收起时纸让线先走一步（inkOut），不然线还挂着纸就没了，红线一瞬间凌空 */
.ndw-scene.leave .paper {
  animation: ndw-pin-out ${MOTION.leave}ms steps(${stepsFor(MOTION.leave / 3)}, jump-none) both;
  animation-delay: calc(${MOTION.inkOut}ms + var(--out, 0) * ${MOTION.stepOut}ms);
}
/* 墨迹分两拨上，**顺序是有意义的**：
   ①「板上的东西」—— 随手涂鸦和写在板子上的字。它们画在板面本身，纸是后来
      钉上去压在它们上面的，所以先出现。
   ②「串纸的东西」—— 红线和手写标签。线是用来连两张纸的，纸还没钉上去线就
      先浮出来，读起来是反的（第一版就是这样，抓过一帧看见线先到）。所以
      它们等**所有纸都钉完**再上：延迟 = 纸的张数 × 一格。
   都走 steps，5 格比纸更碎一点，像墨慢慢洇出来。

   **收起是这一切的倒放**：线先擦掉（它浮在最上面）→ 纸倒序摘 → 板上的墨最后
   淡（它们画在板面上，纸一直压着它们）。顺序反了的话，会看见涂鸦先消失、纸却
   还挂在空板上。 */
.ndw-scene.enter .doodle, .ndw-scene.enter .wall {
  animation: ndw-ink-in ${MOTION.inkIn}ms steps(${stepsFor(MOTION.inkIn)}, jump-none) both;
  animation-delay: calc(var(--i, 0) * ${MOTION.inkStep}ms);
}
.ndw-scene.enter .hand, .ndw-scene.enter .ndw-thread {
  animation: ndw-ink-in ${MOTION.threadIn}ms steps(${stepsFor(MOTION.threadIn)}, jump-none) both;
  animation-delay: calc(var(--pins, 20) * ${MOTION.stepIn}ms + var(--i, 0) * ${MOTION.handStep}ms);
}
.ndw-scene.leave .hand, .ndw-scene.leave .ndw-thread {
  animation: ndw-ink-out ${MOTION.inkOut}ms steps(${stepsFor(MOTION.inkOut)}, jump-none) both;
}
.ndw-scene.leave .doodle, .ndw-scene.leave .wall {
  animation: ndw-ink-out ${MOTION.boardOut}ms steps(${stepsFor(MOTION.boardOut)}, jump-none) both;
  animation-delay: calc(var(--pins, 20) * ${MOTION.stepOut}ms);
}
@media (prefers-reduced-motion: reduce) {
  .ndw-scene.enter *, .ndw-scene.leave * { animation: none !important; opacity: 1 !important; }
}
`;
