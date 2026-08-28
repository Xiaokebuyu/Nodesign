/**
 * 首页样式（2026-08-15 从 Home.jsx 拆出 —— 行数棘轮，样式表是最能整块搬走的一坨）。
 *
 * 这里的取舍全在原注释里，一行没动：板面纤维、笔记本红边线、横线只画在
 * textarea 那一层（纸的高度是内容撑的，横线铺满纸必然切半格）。
 */
import { PAPER_VARS, PAPER_SHADOW } from '../lib/paper.js';

export const CSS = `
/* 板面跟登录墙是同一块板：卡片是拿钉子钉上去的，那底下就不能是一片平涂的色。
   纤维板的织纹和旧钉眼照搬，只把网格线压淡 —— 墙是一屏定死的构图撑得住那个密度，
   首页要滚很长，同样密度会吵。 */
.ndd {
  ${PAPER_VARS}
  position: relative;
  min-height: 100%;
  padding: 32px 40px 90px;
  font-family: var(--kai);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  /* ⛔ 台面这十四层**不画在这儿**（2026-08-28 性能案）。理由见下面 .ndd::before。 */
  background: var(--wall);
}
/*
 * 台面本体：桌布（渐变打光 + 颗粒 + 方格）+ 织纹 + 旧钉眼，一共十四层。
 *
 * ⭐ **必须是 「position: fixed」（视口大小），不能是 absolute（inset:0 铺满 .ndd）**。
 *
 * 这十四层原来分两处画在 「.ndd」 自己身上，而 「.ndd」 的高度**随项目数线性增长**
 * （32 张卡就 2825px）。浏览器按 tile 栅格，于是每滚出一块新 tile 就要把十四层
 * 重新合成一遍 —— 用户报的「项目数一超过某个量首页就奇卡无比」就是这个：
 * 卡片少到不出现滚动条时一次都不用重画，一旦要滚，每块 tile 都是全价。
 *
 * 2026-08-28 真机实测（生产 32 张卡 / dsf2 / 滚到底再滚回顶，trace 量 RasterTask）：
 *
 *   卡 16 → 135ms(12 块) ｜ 卡 32 → 558ms(42 块)，**每块 tile 恒定 ~13ms**
 *   （正常一块 tile 远低于 1ms）
 *
 *   掐 5 个径向渐变 −39% ｜ 掐两条网格线 −27% ｜ 掐整个 ::before −32%
 *   → 不是哪一层特别贵，**是十四层被反复画进一张越长越高的画布**
 *   改成视口固定层：**558ms → 128ms（−77%），且 tile 数从 42 降到 36**
 *
 * ⛔ 试过但更糟的两条：
 *   「background-attachment: fixed」 —— 6644ms / 1604 块 tile，**比原样差 12 倍**
 *      （固定附着背景在滚动容器里会逼着每帧重栅格）。一行省事的改法反把问题放大一个量级。
 *   只把最贵的 5 个径向渐变挪走 —— 460ms，且 tile 数翻倍到 78，不划算。
 *
 * 代价（明写在这，别当 bug 报）：台面纹理和光晕**不再跟着内容滚**，桌子本身固定不动，
 * 纸在桌上滑。桌面隐喻里这更对，但它确实是个视觉改动。
 */
.ndd::before {
  content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(ellipse 80% 40% at 50% -6%, rgba(255,247,225,0.55), transparent 62%),
    radial-gradient(ellipse 44% 22% at 10% 16%, rgba(122,96,56,0.05), transparent 72%),
    radial-gradient(ellipse 40% 20% at 90% 42%, rgba(122,96,56,0.045), transparent 74%),
    radial-gradient(ellipse 34% 18% at 26% 70%, rgba(93,74,44,0.04), transparent 72%),
    radial-gradient(ellipse 30% 16% at 78% 92%, rgba(255,246,218,0.4), transparent 72%),
    var(--grain),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.02) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.02) 0 1px, transparent 1px 28px),
    radial-gradient(circle at 37px 51px, rgba(72,55,32,0.15) 0 1.1px, transparent 1.7px),
    radial-gradient(circle at 119px 23px, rgba(72,55,32,0.12) 0 1px, transparent 1.6px),
    radial-gradient(circle at 61px 137px, rgba(72,55,32,0.1) 0 1.2px, transparent 1.8px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.017) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.013) 0 1px, transparent 1px 3px),
    var(--wall);
  background-size:
    auto, auto, auto, auto, auto,
    auto, auto, auto,
    163px 211px, 271px 149px, 197px 313px, auto, auto,
    auto;
}
.ndd *, .ndd *::before, .ndd *::after { box-sizing: border-box; }
.ndd-in { position: relative; z-index: 1; max-width: 1400px; margin: 0 auto; }

/* 顶区三栏：左边把这周的账写在板子上，中间便签本，右边一个涂鸦。
   便签本原来一个人吊在一大片空板中间，两侧各三百多像素什么都没有。 */
.ndd-top { display: flex; align-items: flex-start; gap: 28px; }
.ndd-mid { flex: 1 1 auto; min-width: 0; }
.ndd-side { flex: 0 0 292px; padding-top: 30px; }
.ndd-side.r { text-align: center; }
/* 两侧各 292 —— 视口不够宽时先把它们收掉，别把便签本挤成一条缝 */
@media (max-width: 1320px) { .ndd-side { display: none; } }

/* 直接写在板上的字：不带纸，是记在板子上的账 */
.ndd-note { color: rgba(122,111,92,0.92); transform: rotate(-0.9deg);
  padding-left: 6px; }
.ndd-note .t { display: block; font: 700 21px var(--kai); letter-spacing: 0.1em;
  line-height: 1.3; color: rgba(104,93,76,0.95); }
.ndd-note .rule { display: block; width: 112px; height: 7px; margin: 5px 0 7px; }
.ndd-note .l { display: block; font: 12.5px var(--kai); line-height: 2.05; }
.ndd-note .n { font-size: 15px; color: rgba(140,127,104,0.95); }

.ndd-side .doodle { display: block; width: 138px; margin: 0 auto; opacity: 0.5; }
.ndd-side .aside { margin-top: 12px; font: 12.5px var(--kai); line-height: 1.95;
  color: rgba(130,119,99,0.9); transform: rotate(0.7deg); }

/* ===== 便签本：一句话开工 ===== */
.ndd-greet { text-align: center; font: 700 25px var(--kai); letter-spacing: 0.05em;
  margin-bottom: 14px; }
/* 模式胶囊（2026-08-27）：设计 / 演出。决定接下来建出的项目是哪种模式。
   形态上是一枚小纸签：楷体、墨色描线、选中格盖一方印章红 —— 跟纸面同族，
   但站在纸外面（它改的是去向，不是纸上的字）。 */
.ndd-mode { display: flex; justify-content: center; gap: 0; margin: 0 auto 14px;
  width: max-content; border: 1px solid rgba(90,78,60,0.45); border-radius: 999px;
  background: var(--paper); box-shadow: 1px 2px 4px rgba(43,33,23,0.14);
  transform: rotate(-0.3deg); overflow: hidden; }
.ndd-mode button { appearance: none; border: 0; background: transparent; cursor: pointer;
  font: 700 13.5px var(--kai); letter-spacing: 0.22em; text-indent: 0.22em;
  color: rgba(110,99,80,0.85); padding: 5px 18px 6px; transition: color 0.15s, background 0.15s; }
.ndd-mode button + button { border-left: 1px solid rgba(90,78,60,0.3); }
.ndd-mode button:hover { color: rgba(63,54,41,0.95); }
.ndd-mode button.on { background: rgba(168,54,43,0.86); color: var(--paper); }
.ndd-mode button:disabled { cursor: default; opacity: 0.55; }
.ndd-pad { position: relative; max-width: 720px; margin: 0 auto;
  padding: 26px 24px 16px 58px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid};
  transform: rotate(-0.35deg);
  /* 2026-08-20：模型下拉被下面的项目卡盖住。transform 让这张纸自成一个层叠上下文，
     ModelPicker 菜单的 zIndex:60 只在纸内部有效；而项目卡的图钉/菜单（.pin/.last/
     .more/.ndd-menu，z 6~9）直接参与 .ndd-in 的层叠、DOM 又在纸后面，于是压过来。
     给纸一个高于 9 的层级 —— 纸和卡片在空间上不重叠，只有菜单弹出来时才见分晓。 */
  z-index: 10;
  transition: box-shadow 0.2s; }
/* 笔记本红边线：字写在线右边，跟随便贴一张白纸区分开 */
.ndd-pad::before { content: ''; position: absolute; left: 40px; top: 0; bottom: 0; width: 1px;
  background: rgba(168,54,43,0.34); }
.ndd-pad .clip { position: absolute; top: -14px; left: var(--cx, 18%); width: 18px; z-index: 4;
  filter: drop-shadow(-1px 2px 2px rgba(43,33,23,0.3)); }
/* 这一层只剩一个用处：给红光标当定位参照（它的高度恒等于 textarea 的高度）。
   横线本身 2026-08-21 挪到 textarea 自己身上去了，理由见下面那条注释。 */
.ndd-pad .lines { position: relative; }
/* 红笔光标（2026-08-15 加，2026-08-17 补上打字时那一半）。

   原生 caret 是 1px 的线，落在米色纸上根本找不着，而且没聚焦时压根没有 ——
   这是首页最该发出的邀请。所以整个输入区的光标**全程由我们自己画**：一根 2px
   的红竖线，空框时蹲在起笔位，打字时跟着插入点走（位置由 lib/textarea-caret.js
   的镜像层量出来，写在 transform 里）。
   ⚠️ 这里**不能再写 top:5px**。measureCaret 量的是行内盒的顶，它**已经含了
   29px 行高里那 5px 半行距**，再叠一个 top 就整体低 5px（改完第一版真跑抓到的：
   空框那根线比 08-15 那版低了一档）。translate 里的 y 就是最终位置。
   placeholder 前面垫了一个 en space 给它让位，所以落笔位置不会跳。

   ⚠️ 只有一个例外：中文输入法**组字期间**把原生 caret 放回来（.composing）——
   那几百毫秒里 value 和 selectionStart 都在跳，自己画只会抖，而且 IME 的候选框
   本来就跟着原生 caret 走。 */
.ndd-pad .caret { position: absolute; left: 0; top: 0; width: 2px; height: 20px;
  background: var(--red); pointer-events: none;
  animation: nddCaret 1.06s steps(1, end) infinite; }
@keyframes nddCaret { 0%, 49.9% { opacity: 1; } 50%, 100% { opacity: 0; } }
.ndd-pad textarea { width: 100%; background-color: transparent; border: none; outline: none;
  resize: none; display: block;
  font: 16.5px var(--kai); line-height: 29px; color: var(--ink);
  /* 原生 caret 全程让位给上面那根自己画的（唯一例外是组字期间） */
  caret-color: transparent;
  padding: 0; max-height: 290px; min-height: 116px; overflow: auto;
  /* 横线画在 textarea **自己身上**，靠 background-attachment: local 跟着内容一起滚
     （2026-08-21）。原来画在外层 .lines 上：那一层不滚，于是粘一段长文之后随便滚一下
     滚动量就不是 29 的整数倍，横线当场横穿字面 —— 用户报的"横线浮在文字上方"就是它。
     ⚠️ 上面必须写 background-color 而不是 background 简写：简写会把 attachment 重置回
     scroll，横线又不跟着滚了，而且这种回退不报错、只在滚起来之后才看得见。
     ⚠️ 29px 这个格高跟 line-height 是同一个数，改一个必须改另一个。 */
  background-image: linear-gradient(180deg, transparent 0 28px, rgba(43,33,23,0.17) 28px 29px);
  background-size: 100% 29px; background-position: 0 0; background-attachment: local; }
.ndd-pad textarea.composing { caret-color: var(--red); }
.ndd-pad textarea::placeholder { color: var(--pencil); }
/* 光标之外还得有个状态信号：整张纸没有边框，光靠一根闪的竖线判断"进没进输入态"
   太吃力。聚焦时纸抬起来一档、横线加深、红边线变实 —— 三样一起动，看不错。 */
.ndd-pad:focus-within { box-shadow: ${PAPER_SHADOW.near}; }
.ndd-pad:focus-within::before { background: rgba(168,54,43,0.6); }
.ndd-pad:focus-within textarea {
  background-image: linear-gradient(180deg, transparent 0 28px, rgba(43,33,23,0.24) 28px 29px); }
.ndd-pad .bar { display: flex; align-items: center; gap: 10px; padding-top: 14px; }
.ndd-pad .tip { font: 11px var(--kai); color: var(--pencil); letter-spacing: 0.02em; }
.ndd-pad .att { width: 27px; height: 27px; border-radius: 50%; flex-shrink: 0;
  background: transparent; border: 1px solid rgba(43,33,23,0.2); color: var(--ink-2);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  transition: border-color 0.15s, color 0.15s; }
.ndd-pad .att:hover { border-color: var(--ink); color: var(--ink); }
.ndd-pad .att:disabled { opacity: 0.45; cursor: default; }
/* 模型选择：ModelPicker 自带的是全站 chrome 那套皮（无衬线 + 圆角），落在纸上
   像一颗从别处剪来的按钮。只改字与形，**颜色一律不碰** —— 它的底色本来就在
   传达"你选过没有"（选过是实心墨块，跟隔壁开工钮同一支墨），改了就把信号抹平。
   要 !important 是因为组件写的是内联样式。 */
.ndd-pad .model > button { font: 12.5px var(--kai) !important; letter-spacing: 0.04em;
  padding: 4px 9px !important; border-radius: 2px !important; }
/* 没写字的时候是个空框，写了字才变成实心墨块 —— 淡一档的实心块看着像坏了 */
.ndd-pad .go { padding: 8px 22px; font: 700 14px var(--kai);
  letter-spacing: 0.3em; text-indent: 0.3em;
  background: var(--ink); color: #F5F0E4;
  border: 1px solid var(--ink); border-radius: 2px; cursor: pointer;
  transition: background 0.18s, color 0.18s, border-color 0.18s; }
.ndd-pad .go:disabled { background: transparent; color: var(--pencil);
  border-color: rgba(43,33,23,0.22); cursor: default; }

/* ===== 分区标题 ===== */
.ndd-head { display: flex; justify-content: space-between; align-items: baseline;
  margin: 44px 0 24px; }
.ndd-head h2 { position: relative; margin: 0;
  font: 700 20px var(--kai); letter-spacing: 0.08em; }
.ndd-head h2 svg { position: absolute; left: -2%; bottom: -8px; width: 104%; height: 8px; }
.ndd-head .n { font: 12.5px var(--kai); color: var(--pencil); letter-spacing: 0.06em; }

/* ===== 项目卡：钉在板上的纸 ===== */
.ndd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 36px 28px; }
.ndd-card { position: relative; }
/* 钉子不在纸里 —— 纸被拿起来的时候钉子不该跟着动 */
.ndd-card .pin { position: absolute; top: 3px; left: 50%; width: 9px; height: 9px;
  border-radius: 50%; margin-left: -4.5px; z-index: 6; pointer-events: none;
  background: radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); }
.ndd-card .pin.r { background: radial-gradient(circle at 35% 30%, #b4544a, #7d241c 65%); }
.ndd-card > a { display: block; position: relative; padding: 15px 14px 12px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid};
  text-decoration: none; color: inherit;
  transform: rotate(var(--rot, 0deg)); transform-origin: 50% 7px;
  transition: transform 0.28s cubic-bezier(0.25,1,0.5,1), box-shadow 0.28s; }
/* 挂在最上面那张贴得没那么平 */
.ndd-card.top > a { box-shadow: ${PAPER_SHADOW.near}; }
/* hover = 从桌上拿起来看：转正、抬起、影子摊开。
   触发点挂在整张卡上而不是 <a> 上 —— ⋯ 按钮是 <a> 的兄弟节点，鼠标移到它上面
   就不在 <a> 里了，纸会当场掉回去 */
.ndd-card:hover > a { transform: rotate(0deg) translateY(-5px);
  box-shadow: ${PAPER_SHADOW.near}; }

/* 封面 = 贴在纸上的印样，自己有一层薄影 */
.ndd-shot { position: relative; width: 100%; overflow: hidden; background: #EFEAE0;
  box-shadow: 0 1px 2px rgba(93,74,44,0.22), inset 0 0 0 1px rgba(43,33,23,0.07); }
.ndd-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top;
  display: block; border: 0; }
/* 还没出东西：一张空白的横线纸，不是坏掉的灰块。
   不写字 —— 空白本身就说明了，「还没出东西」那句话由下面那行元信息说一次就够。 */
.ndd-shot.empty {
  background-color: #FBF7EC;
  background-image: repeating-linear-gradient(180deg, transparent 0 21px, rgba(43,33,23,0.05) 21px 22px);
  box-shadow: inset 0 0 0 1px rgba(43,33,23,0.06); }

.ndd-card .t { margin-top: 12px; font: 700 15.5px var(--kai); letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ndd-card .m { margin-top: 5px; display: flex; justify-content: space-between;
  align-items: baseline; gap: 10px; font: 11.5px var(--kai); color: var(--pencil); }
.ndd-card .m span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 上次停在这：回访第一动作 */
.ndd-card .last { position: absolute; top: -10px; right: -7px; z-index: 7;
  padding: 2px 9px; font: 11.5px var(--kai); color: var(--red);
  background-color: var(--sticky); background-image: var(--grain);
  box-shadow: -1px 2px 3px rgba(93,74,44,0.22);
  transform: rotate(4deg); pointer-events: none; }
.ndd-card .more { position: absolute; top: 9px; right: 9px; z-index: 8;
  width: 26px; height: 26px; border-radius: 50%;
  background: rgba(255,254,246,0.94); border: 1px solid rgba(43,33,23,0.16);
  color: var(--ink-2); display: flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: -1px 2px 4px rgba(93,74,44,0.2); }
.ndd-menu { position: absolute; top: 40px; right: 8px; z-index: 9; min-width: 132px;
  padding: 5px;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.near}; }
.ndd-menu button { width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; font: 13px var(--kai); color: var(--ink-2);
  background: transparent; border: none; text-align: left; cursor: pointer; }
.ndd-menu button:hover { background: rgba(43,33,23,0.055); color: var(--ink); }
.ndd-menu button.danger { color: var(--red); }
.ndd-menu button.danger:hover { background: rgba(168,54,43,0.08); }

/* ===== 最近对话（老式闪聊会话，没有就整块不出现）===== */
.ndd-rows { background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.far}; }
.ndd-rows a { display: flex; align-items: center; gap: 14px; padding: 12px 18px;
  text-decoration: none; color: inherit; transition: background 0.15s; }
.ndd-rows a:hover { background: rgba(43,33,23,0.03); }
.ndd-rows .sep { border-top: 1px solid rgba(43,33,23,0.08); }
.ndd-rows .t { font: 14px var(--kai); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.ndd-rows .w { margin-top: 2px; font: 11px var(--kai); color: var(--pencil); }
.ndd-rows .del { position: absolute; top: 50%; right: 14px; transform: translateY(-50%);
  width: 25px; height: 25px; border-radius: 50%; z-index: 3;
  background: rgba(255,254,246,0.95); border: 1px solid rgba(43,33,23,0.16);
  color: var(--ink-2); display: flex; align-items: center; justify-content: center;
  cursor: pointer; }
.ndd-rows .del:hover { color: var(--red); border-color: var(--red); }

/* ===== 空 / 出错：都是钉上去的一张纸 ===== */
.ndd-sheet { position: relative; max-width: 620px; margin: 0 auto;
  padding: 42px 40px 34px; text-align: center;
  background-color: var(--paper); background-image: var(--grain);
  box-shadow: ${PAPER_SHADOW.mid};
  transform: rotate(0.4deg); transform-origin: 50% 8px; }
.ndd-sheet .pin { position: absolute; top: 8px; left: 50%; width: 9px; height: 9px;
  border-radius: 50%; margin-left: -4.5px;
  background: radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); }
.ndd-sheet .h { font: 700 17px var(--kai); letter-spacing: 0.05em; }
.ndd-sheet .d { margin-top: 10px; font: 13.5px var(--kai); line-height: 1.85; color: var(--ink-2); }
.ndd-sheet .chips { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
  margin-top: 22px; }
.ndd-sheet .chips button { padding: 7px 16px; font: 13px var(--kai); color: var(--ink-2);
  background: transparent; border: 1px solid rgba(43,33,23,0.2); border-radius: 999px;
  cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.ndd-sheet .chips button:hover { border-color: var(--ink); color: var(--ink); }
.ndd-sheet .foot { margin-top: 22px; font: 12.5px var(--kai); color: var(--pencil);
  background: transparent; border: none; text-decoration: underline;
  text-underline-offset: 3px; cursor: pointer; }
.ndd-sheet .retry { margin-top: 20px; padding: 9px 26px; font: 700 14px var(--kai);
  letter-spacing: 0.24em; text-indent: 0.24em;
  background: var(--ink); color: #F5F0E4; border: none; border-radius: 2px; cursor: pointer; }
.ndd-quiet { padding: 60px 0; text-align: center; font: 13.5px var(--kai); color: var(--pencil); }

/* ═════════ 窄屏（2026-08-21 移动端适配）═════════
   只动**尺寸**，不动结构：三栏里两侧的板上笔记 1320 以下本来就收掉了，
   剩下的问题全是"照着 1440 的留白排在 393 的屏上"。
   ⚠️ textarea 的 min/max-height 一个都别在这儿改 —— 它们必须是 29 的整数倍
   （见上面横线那一段），改了最后一格会被切一半，而 lint 只看基础规则。 */
@media (max-width: 640px) {
  .ndd { padding: 20px 12px 64px; }
  .ndd-greet { font-size: 21px; letter-spacing: 0.03em; margin-bottom: 14px; }
  /* 纸：左边那条页边留白按比例收，红线跟着挪，不然线压在字上 */
  .ndd-pad { padding: 20px 14px 12px 40px; }
  .ndd-pad::before { left: 26px; }
  /* 工具栏一行排不下就折行；「开工」始终自己占右边 */
  .ndd-pad .bar { flex-wrap: wrap; gap: 8px; padding-top: 12px; }
  .ndd-pad .go { padding: 8px 18px; letter-spacing: 0.22em; text-indent: 0.22em; }
  .ndd-pad .model > button { padding: 4px 8px !important; }
  /* 便签本收成 3 格（29 的整数倍，别写别的数）—— 手机上 4 格加工具栏要吃掉三分之一屏 */
  .ndd-pad textarea { min-height: 87px; }
  .ndd-head { margin: 32px 0 18px; }
  .ndd-head h2 { font-size: 18px; }
  /* 手机上项目卡**单列** + 换成橱窗那种平卡（08-21 用户拍板；中间试过双列，卡太小）。
     平板不进这个断点，照旧是钉在板上的歪纸。
     为什么手机上换掉"钉在板上"那套：歪斜 + 图钉是**一墙纸片**的语言，靠彼此的错落
     成立；一列窄卡从上往下排的时候，歪斜只剩边缘毛糙，图钉变成每张卡头上一个黑点。
     橱窗那张卡是**一件作品的展台**：封面比例统一、卡面平、字在下面 —— 一列排下来
     每张一样高，一眼扫得完。 */
  .ndd-grid { grid-template-columns: 1fr; gap: 22px; }
  .ndd-card > a,
  .ndd-card:hover > a { transform: none; padding: 0 0 14px; }
  .ndd-card .pin { display: none; }
  /* ⚠️ 封面的比例是 JS 按真实图算出来写在**内联样式**上的（Home.jsx 的 ThumbnailBox），
     这里要覆盖它只能 !important —— 手机上统一 16:10，卡才会一样高。 */
  .ndd-shot { aspect-ratio: 16 / 10 !important;
    box-shadow: none; border-bottom: 1px solid rgba(43,33,23,0.09); }
  .ndd-card .t { margin-top: 11px; padding: 0 14px; }
  .ndd-card .m { padding: 0 14px; }
  /* 「接着做」收进封面里，别挂在卡外面（窄屏上它会顶到屏幕边） */
  .ndd-card .last { top: 8px; right: 8px; transform: rotate(2deg); }
  .ndd-rows a { padding: 12px 14px; }
  .ndd-sheet { padding: 26px 18px; }
  .ndd-sheet .chips { gap: 8px; }
}
`;
