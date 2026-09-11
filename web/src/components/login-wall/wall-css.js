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
import { PAPER_VARS, P, PAPER_SHADOW, INK_EDGE, pinFill, PIN_SHADOW } from '../../lib/paper.js';
import { COLOR } from '../../lib/theme.js';
import { DESIGN_W, DESIGN_H, SAFE_H, NAV_H } from './geometry.js';

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
  // ⭐ 一张卡自己的动作走 15 格（够顺）；张与张之间的间隔是定格感所在。
  //    09-12 印刷风改版：一套只剩 ①→⑥ 六步（原来一面墙二十来张纸），间隔从 256ms 拉到 800ms
  //    —— 六张按 256 排，1.5 秒就钉完了，读不出"一步接一步"。站主要的就是这个"连续步骤与卡片出现"。
  enter: 480, stepIn: 800,
  leave: 480, stepOut: 160,    // 摘的时候快一点（手往下捋），错开 5 格
  threadIn: 704,               // 红线画出来（等所有纸钉完才开始）
  inkOut: 320, boardOut: 384,  // 收起时：线先擦、板上的墨最后淡
  still: 2400,                 // 钉完之后站着不动的那一拍（六步要读完一遍，比原来的 1.44s 长）
  inkIn: 384, inkStep: 96,     // 板上的墨：单个的时长 / 彼此错开
  handStep: 160,               // 手写标签彼此错开
};

/** 每套场景的步数：轮播的定时器按它算进出场要多久（场景文件里 .paper 的个数跟它对账，见 scenes 的测试） */
export const STEPS = 6;

/**
 * 进场 / 退场各要多久 —— 轮播的定时器按它算，`n` 是这一套有几张纸。
 *
 * ⚠️ 进场的尾巴不是最后一张纸，是**红线那一拨**：它要等所有纸钉完才开始画。
 * 按纸算完就摘 class 的话，线会在半路被掐掉直接跳到全黑。
 * ⚠️ 退场的尾巴也不是纸，是**板上的墨**：纸摘光了它们才淡（正好是进场顺序的倒放）。
 */
export const enterMs = (n) => n * MOTION.stepIn + MOTION.threadIn;
export const leaveMs = (n) => Math.max(
  MOTION.inkOut + Math.max(0, n - 1) * MOTION.stepOut + MOTION.leave,
  n * MOTION.stepOut + MOTION.boardOut,
);

export const WALL_CSS = `
/* ===== 09-12 印刷风改版 =====
   门外这一页跟官网、跟进门之后是同一种纸：平光的印刷纸（纸纤维 + 颗粒）、墨线描边的纸、
   不模糊的错位影、粗黑体标题、等宽的元数据，红笔只用在编号、连线和「用户圈的那一下」上。
   软木板、窗光、旧钉眼、涂鸦、歪角、风吹纸摆都退役了（站主 09-12：摆正、去掉涂鸦）。 */
.ndw {
  ${PAPER_VARS}
  position: fixed; inset: 0; overflow: hidden;
  font-family: var(--display); color: var(--ink);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(118% 112% at 50% 45%, transparent 56%, rgba(31,24,16,0.09)),
    var(--grain),
    var(--wall);
}
.ndw * { margin: 0; padding: 0; box-sizing: border-box; }
.ndw a { color: inherit; }

/* 印刷记号：四角裁切线、左下色标、右下竖排的校样日期（同官网） */
.ndw-proof { position: absolute; inset: 0; z-index: 30; pointer-events: none; }
.ndw-proof i { position: absolute; width: 16px; height: 16px; border: 0 solid var(--pencil); opacity: 0.55; }
.ndw-proof .tl { top: 72px; left: 20px; border-top-width: 1px; border-left-width: 1px; }
.ndw-proof .tr { top: 72px; right: 20px; border-top-width: 1px; border-right-width: 1px; }
.ndw-proof .bl { bottom: 20px; left: 20px; border-bottom-width: 1px; border-left-width: 1px; }
.ndw-proof .br { bottom: 20px; right: 20px; border-bottom-width: 1px; border-right-width: 1px; }
.ndw-proof .bar { position: absolute; left: 20px; bottom: 48px; display: flex; gap: 3px; }
.ndw-proof .bar b { display: block; width: 11px; height: 11px; }
.ndw-proof .bar b:nth-child(1) { background: #2E6B7A; } .ndw-proof .bar b:nth-child(2) { background: #B23A2E; }
.ndw-proof .bar b:nth-child(3) { background: #C9A227; } .ndw-proof .bar b:nth-child(4) { background: var(--ink); }
.ndw-proof .tag { position: absolute; right: 20px; bottom: 48px; font: 10px var(--code); letter-spacing: 0.2em;
  color: var(--pencil); writing-mode: vertical-rl; }

/* 顶栏：不进 1500x800 的稿（不跟着缩放），横贯整个视口，同官网 */
.ndw-nav { position: absolute; top: 0; left: 0; right: 0; height: ${NAV_H}px; z-index: 20;
  display: flex; align-items: center; gap: 28px; padding: 0 40px;
  background: ${P('wall',0.92)}; border-bottom: 1px solid ${INK_EDGE}; }
.ndw-nav .brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none;
  font: 800 20px var(--display); letter-spacing: -0.02em; }
.ndw-nav .brand img { width: 22px; height: 22px; border-radius: 5px; display: block; }
.ndw-nav .links { margin-left: auto; display: flex; align-items: center; gap: 26px;
  font: 13px var(--code); letter-spacing: 0.06em; color: var(--ink-2); }
.ndw-nav .links a { text-decoration: none; }
.ndw-nav .links a:hover { color: var(--ink); }

/* 整面墙 = 一张 1500x800 的设计稿，从顶栏下沿开始、顶边对齐缩放 */
.ndw-stage {
  position: absolute; z-index: 1; left: 50%; top: ${NAV_H}px;
  margin-left: -${DESIGN_W / 2}px;
  width: ${DESIGN_W}px; height: ${DESIGN_H}px;
  transform: scale(var(--s, 1));
  transform-origin: top center;
}

/* ===== 一步 = 一整块（纸 + 编号 + 图注）一起钉上去 =====
   .paper 是动画的单位（Scene.jsx 按 DOM 顺序发 --i）；真正的纸是里面的 .sheet。 */
.ndw .paper { position: absolute; z-index: 2; }
.ndw .sheet { position: relative; background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid}; }
.ndw .sheet.near { box-shadow: ${PAPER_SHADOW.near}; }
.ndw .sheet.sticky { background-color: var(--sticky); }
.ndw .sheet.term { background: #241D14; box-shadow: 0 0 0 1px #241D14, -2px 5px 0 rgba(31,24,16,0.2);
  color: #E4DCC8; padding: 12px 14px; }
.ndw .term .h { font: 600 11px var(--code); color: #9b917c; letter-spacing: 0.12em;
  border-bottom: 1px solid rgba(228,220,200,0.18); padding-bottom: 6px; margin-bottom: 6px; }
.ndw .term .l { font: 11.5px/1.9 var(--code); white-space: nowrap; }
.ndw .term .l i { font-style: normal; color: #9DBF9A; margin-right: 6px; }
.ndw .term .l span { color: #8A8069; }
.ndw .term .run { margin-top: 6px; font: 10.5px var(--code); color: #8A8069; }
/* 卡头：牛皮色页眉（同画布卡头） */
.ndw .bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid #C7B79A;
  background: #E3D8C0; font: 11px var(--code); color: var(--pencil); white-space: nowrap; }
.ndw .bar .dot { width: 7px; height: 7px; background: #B23A2E; flex: none; }
.ndw .bar .name { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; }
.ndw .bar .st { margin-left: auto; }
.ndw .shot { display: block; width: 100%; height: auto; }
/* 便签：人说的那句话（楷体，人写的） */
.ndw .note { padding: 14px 15px 12px; }
.ndw .note .who { font: 10.5px var(--code); color: var(--pencil); letter-spacing: 0.14em; }
.ndw .note p { margin-top: 6px; font: 15px/1.65 var(--kai-real); color: var(--ink); }
.ndw .note .when { margin-top: 8px; font: 10.5px var(--code); color: var(--pencil); }
/* 板书：直接写在板上（标题粗黑体，正文阅读楷体 —— 09-12 板书改用易读字体） */
.ndw .chalk .t { font: 800 17px var(--display); letter-spacing: -0.01em; border-bottom: 1px solid var(--ink);
  padding-bottom: 6px; margin-bottom: 6px; }
.ndw .chalk ol { list-style: none; font: 14px/1.85 var(--read); color: var(--ink-2); }
.ndw .chalk li b { font: 400 10.5px var(--code); color: var(--pencil); margin-right: 8px; }
.ndw .chalk li.del { color: var(--red); text-decoration: line-through; }
/* 卡里的一段文字（角色卡、试演页） */
.ndw .txt { padding: 12px 14px; font: 13.5px/1.75 var(--read); color: var(--ink-2); }
.ndw .txt b { font: 600 10.5px var(--code); color: var(--pencil); letter-spacing: 0.08em; margin-right: 6px; }
.ndw .txt .say { color: var(--ink); }
/* 编号：红圈 + 等宽数字 */
.ndw .no { position: absolute; left: -14px; top: -14px; z-index: 7; width: 28px; height: 28px;
  border: 1.8px solid var(--red); border-radius: 50%; background: ${P('paper',0.92)};
  font: 600 13px/24px var(--code); color: var(--red); text-align: center; }
.ndw .cap { margin-top: 7px; font: 11px var(--code); color: var(--pencil); letter-spacing: 0.06em; white-space: nowrap; }
.ndw .stamp { position: absolute; z-index: 7; font: 600 12px var(--code); letter-spacing: 0.2em; color: var(--red);
  border: 1.8px solid var(--red); padding: 3px 9px; transform: rotate(-6deg); background: ${P('paper',0.6)}; }
/* 钉子：硬边平涂 + 硬影（同首页） */
.ndw .pin { position: absolute; top: -5px; left: 50%; width: 11px; height: 11px; margin-left: -5.5px;
  border-radius: 50%; background: ${pinFill()}; box-shadow: ${PIN_SHADOW}; z-index: 6; }
.ndw .pin.r { background: ${pinFill(true)}; }
/* ⑤ 用户圈的那一下：红笔直接画在别的纸上（这一步没有自己的纸） */
.ndw .circle { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.ndw .circle path { fill: none; stroke: var(--red); stroke-width: 2.2; stroke-linecap: round; opacity: 0.92; }
/* ⑤ 那句红笔字跟着第 5 步一起钉上去（不能用 .hand：.hand 要等所有纸钉完才出来） */
.ndw .pen-note { position: absolute; font: 17px/1.35 var(--kai-real); color: var(--red); white-space: nowrap; }
.ndw .pen-note .cap { color: var(--red); opacity: 0.85; }

/* 线索线：连着相邻两步，等所有步钉完才画上去 */
.ndw-thread { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
.ndw-thread path { fill: none; stroke: var(--red); stroke-width: 1.8; stroke-linecap: round; opacity: 0.8; }
.ndw .hand { position: absolute; font: 17px/1.35 var(--kai-real); color: var(--red); z-index: 7; white-space: nowrap; }

/* ===== 标题（跨场景不变的锚一）=====
   ⚠️ 这块地是**壳跟场景之间的约定**：三套场景的第一行纸都从 y=236 往下摆，标题整块不许越过它。 */
.ndw-head { position: absolute; left: 60px; top: 30px; z-index: 3; width: 760px; }
.ndw-anno { display: block; font: 11px var(--code); color: var(--pencil); letter-spacing: 0.28em; text-transform: uppercase; }
.ndw-head h1 { margin-top: 14px; font: 800 50px/1.08 var(--display); letter-spacing: -0.028em;
  text-shadow: .028em .02em 0 rgba(178,58,46,0.16); }
.ndw-sub { margin-top: 14px; max-width: 37em; font: 16px/1.8 var(--read); color: var(--ink-2); }

/* ===== 登记卡（跨场景不变的锚二）：竖向居中在稿的可见区中线上（09-12 站主：原来太高） ===== */
/* 稿是按 --s 缩放、从顶栏下沿开始的，所以「视口中线」换算回稿里的坐标 = (50vh - 顶栏) / --s */
.ndw-card { position: absolute; right: 60px; top: calc((50vh - ${NAV_H}px) / var(--s, 1)); transform: translateY(-50%); width: 390px;
  padding: 32px 34px 26px; background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.near}; z-index: 8; }
.ndw-card > .pin { top: -5px; }
.ndw-card h2 { font: 800 23px var(--display); letter-spacing: -0.015em; }
.ndw-card .m { margin-top: 6px; font: 13.5px var(--display); color: var(--pencil); }
.ndw-tabs { margin-top: 22px; display: flex; gap: 26px; border-bottom: 1px solid #C7B79A; }
.ndw-tabs button { background: none; border: none; padding: 0 0 9px; cursor: pointer;
  font: 700 15px var(--display); color: var(--pencil); }
.ndw-tabs button.on { color: var(--ink); box-shadow: inset 0 -2px 0 var(--red); }
.ndw-field { margin-top: 20px; }
.ndw-field label { display: block; font: 11px var(--code); letter-spacing: 0.14em; color: var(--pencil); }
.ndw-field input { width: 100%; margin-top: 4px; padding: 7px 1px; font: 16px var(--read);
  background: transparent; border: none; border-bottom: 1px solid ${P('ink',0.45)}; outline: none; color: var(--ink); }
.ndw-field input::placeholder { color: var(--pencil); }
.ndw-field input:focus { border-bottom-color: var(--ink); }
.ndw-err { margin-top: 12px; min-height: 17px; font: 12.5px var(--display); color: var(--red); }
.ndw-card button.go { width: 100%; margin-top: 10px; padding: 14px 0; font: 700 16px var(--display);
  letter-spacing: 0.3em; text-indent: 0.3em; background: var(--ink); color: ${COLOR.btnText};
  border: none; border-radius: 3px; cursor: pointer; }
.ndw-card button.go:disabled { opacity: 0.55; cursor: default; }
.ndw-card .foot { margin-top: 14px; font: 12.5px var(--display); color: var(--pencil); text-align: center; }
.ndw-card .alt { margin-top: 18px; padding-top: 14px; border-top: 1px solid #D9CDB4; display: flex;
  justify-content: space-between; font: 11.5px var(--code); color: var(--ink-2); }
.ndw-card .alt a { text-decoration: none; }
.ndw-stamp { position: absolute; right: 20px; top: 22px; padding: 2px 8px; border: 1px solid var(--red);
  color: var(--red); font: 10.5px var(--code); letter-spacing: 0.16em; }

/* ===== 窄屏：整面墙收起，只留登记卡（顶栏还在） ===== */
.ndw.narrow { display: grid; place-items: center; padding: ${NAV_H + 24}px 24px 24px; }
.ndw.narrow .ndw-stage, .ndw.narrow .ndw-proof { display: none; }
.ndw.narrow .ndw-nav { padding: 0 16px; }
/* 窄屏那张卡沿用 .ndw-card 的全部内部样式，只把定位和宽度改掉 */
.ndw-solo { position: relative; right: auto; top: auto; transform: none;
  width: 100%; max-width: 360px; padding: 30px 26px 22px; }
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
/* 09-12 印刷风：幅度收小（站主：卡片出现时不需要那么大的晃动）—— 纸摆正了，钉上去只需落下一点、
   轻轻压一下再坐稳；原来 3° / 14px 是给歪着钉、会晃的纸准备的。格数和节拍一格没动。 */
@keyframes ndw-pin-in {
  0%       { opacity: 0; transform: rotate(calc(var(--rot, 0deg) + 0.8deg)) translate(2px, -7px); }
  33.3333% { opacity: 1; transform: rotate(calc(var(--rot, 0deg) + 0.35deg)) translate(1px, -3px); }
  66.6667% { opacity: 1; transform: rotate(calc(var(--rot, 0deg) - 0.15deg)) translate(0, 1px); }
  100%     { opacity: 1; transform: rotate(var(--rot, 0deg)) translate(0, 0); }
}
/* 摘下来先"揭"一下再掉：20% 那帧往回抬一点，像手先把纸从钉子上挑起来 */
@keyframes ndw-pin-out {
  0%       { opacity: 1; transform: rotate(var(--rot, 0deg)) translate(0, 0); }
  33.3333% { opacity: 1; transform: rotate(calc(var(--rot, 0deg) + 0.4deg)) translate(1px, -2px); }
  66.6667% { opacity: 0.6; transform: rotate(calc(var(--rot, 0deg) - 0.6deg)) translate(-2px, 4px); }
  100%     { opacity: 0; transform: rotate(calc(var(--rot, 0deg) - 1.4deg)) translate(-4px, 9px); }
}
/* 板上的字、涂鸦、线索线没有 --rot，单独一套（只跳明暗，不跳位置） */
@keyframes ndw-ink-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes ndw-ink-out { from { opacity: 1 } to { opacity: 0 } }

/* （09-12 起没有风吹纸摆了 —— 印刷风的纸摆正、不晃。原来这两条靠特异度压过 .sway，那条规则已经退役。） */
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
.ndw-scene.enter .wall {
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
.ndw-scene.leave .wall {
  animation: ndw-ink-out ${MOTION.boardOut}ms steps(${stepsFor(MOTION.boardOut)}, jump-none) both;
  animation-delay: calc(var(--pins, 20) * ${MOTION.stepOut}ms);
}
@media (prefers-reduced-motion: reduce) {
  .ndw-scene.enter *, .ndw-scene.leave * { animation: none !important; opacity: 1 !important; }
}
`;
