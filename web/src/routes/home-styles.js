/**
 * 首页样式（2026-08-15 从 Home.jsx 拆出 —— 行数棘轮，样式表是最能整块搬走的一坨）。
 *
 * 这里的取舍全在原注释里，一行没动：板面纤维、笔记本红边线、横线只画在
 * textarea 那一层（纸的高度是内容撑的，横线铺满纸必然切半格）。
 */
import { PAPER_SHADOW, PAPER, P } from '../lib/paper.js';
import { COLOR } from '../lib/theme.js';
// ⭐ 台面那一段搬进了 desk.jsx（橱窗和 Skill 页要共用），这里仍然把它拼进来 ——
//    首页只注入一份样式，两条读 CSS 的 lint 也照旧读得到。
import { DESK_CSS } from './desk.jsx';

export const CSS = `
${DESK_CSS}

/* 顶区三栏：左边把这周的账写在板子上，中间便签本，右边一个涂鸦。
   便签本原来一个人吊在一大片空板中间，两侧各三百多像素什么都没有。 */
.ndd-top { display: flex; align-items: flex-start; gap: 28px; }
.ndd-mid { flex: 1 1 auto; min-width: 0; }
.ndd-side { flex: 0 0 292px; padding-top: 30px; }
.ndd-side.r { text-align: center; }
/* 两侧各 292 —— 视口不够宽时先把它们收掉，别把便签本挤成一条缝 */
@media (max-width: 1320px) { .ndd-side { display: none; } }

/* 直接写在板上的字：不带纸，是记在板子上的账 */
.ndd-note { color: var(--sketch); transform: rotate(-0.9deg);
  padding-left: 6px; }
.ndd-note .t { display: block; font: 700 21px var(--kai); letter-spacing: 0.1em;
  line-height: 1.3; color: var(--sketch-deep); }
.ndd-note .rule { display: block; width: 112px; height: 7px; margin: 5px 0 7px; }
.ndd-note .l { display: block; font: 12.5px var(--kai); line-height: 2.05; }
.ndd-note .n { font-size: 15px; color: var(--sketch-num); }

.ndd-side .doodle { display: block; width: 138px; margin: 0 auto; opacity: 0.5; }
.ndd-side .aside { margin-top: 12px; font: 12.5px var(--kai); line-height: 1.95;
  color: var(--sketch-soft); transform: rotate(0.7deg); }

/* ===== 便签本：一句话开工 ===== */
/* ⭐ 这两处（问候语、分组标题）是直接写在台面上的 —— 颜色必须显式走 --desk-ink，
   夜里才跟着翻粉笔。别指望从 .ndd 继承：那条继承链上还挂着一堆摊在纸上的卡片。 */
.ndd-greet { color: var(--desk-ink); text-align: center; font: 700 25px var(--kai); letter-spacing: 0.05em;
  /* 纸上沿探出来的那两片页签要占掉约 28px，别贴到问候语上 */
  margin-bottom: 30px; }
/* ===== 页签：设计 / 演出 =====

   08-27 第一版是纸外面一枚 999px 圆角、选中格实心红的胶囊 —— 整张首页只有它
   一个长得像"控件"，这套语言里所有东西都是纸、靠影子跟底面分开，它怎么调都突兀。
   08-28 改成纸自己的索引签，但当时贴在纸**前面**，只能靠"选中的高一档、没选的
   矮一档"假装谁在后面 —— 于是每次切换两片签都上下跳，而且"谁被压着"其实看不出来。

   现在它是**这一叠**的签，跟纸是兄弟且排在纸前面（层叠上被纸压住）：
     露在纸上沿外面的那一截 = 能看见的部分；下缘那 12px 真的藏在纸后面
     选中那片跟纸同色同颗粒 → 接口处没有分界线，它就是最上面这张纸
     没选那片是牛皮色 + 一层压暗 → 它是被纸压着的下一张
     选中那片 z 更高、跟旁边那片横向压着 6px → 一眼看出谁在上面

   ⭐ 两片签的**几何完全一样**（同 padding 同 margin），换模式只换颜色。用户原话：
   "两个便签条在翻页的时候不要做出上下跳动"。位移一律不许再加回来，由
   home-pad.lint.test.js 逐条属性拦。 */
.nd-tabs { position: absolute; right: 30px; bottom: 100%; margin-bottom: -12px;
  display: flex; align-items: flex-end; }
.nd-tabs > * { appearance: none; border: none; cursor: pointer;
  font: 700 13px var(--kai); letter-spacing: 0.2em; text-indent: 0.2em;
  /* 下缘那 12px 藏在纸后面（= 条的 margin-bottom 那个数），露出来的只有上面这截 */
  padding: 5px 15px 16px; border-radius: 3px 3px 0 0;
  background: var(--kraft); color: ${P('tabInk',0.8)};
  /* 被前面那张纸压着 = 整片压暗一层 */
  box-shadow: inset 0 0 0 999px rgba(93,74,44,0.07);
  position: relative; z-index: 1;
  transition: color 0.26s, background-color 0.26s, box-shadow 0.26s; }
/* 相邻两片横向压着一点：谁在上面一眼看得出（纯静态，不是位移） */
.nd-tabs > * + * { margin-left: -6px; }
/* 选中那片 = 最上面这张纸的签：跟纸读同一个 --sheet，压在旁边那片上面 */
.nd-tabs > *.on { background-color: var(--sheet); background-image: var(--grain);
  color: var(--red); box-shadow: none; z-index: 2; }
/* 摸上去只提亮，不动位置 */
.nd-tabs > *:not(.on):hover { color: var(--ink);
  box-shadow: inset 0 0 0 999px rgba(93,74,44,0.02); }
.nd-tabs > *:disabled { cursor: default; opacity: 0.55; }
/* 签在纸后面：整叠自己成一个层叠上下文，签 z1、纸 z2 */
.ndd-stack { position: relative; max-width: 720px; margin: 0 auto; z-index: 10;
  transform: rotate(-0.35deg); }
.ndd-stack > .nd-tabs { z-index: 1; }

/* ===== 两种纸的配方（2026-08-28）=====

   一张纸 = 底色 + 格线 + 页边/版心 + 它下面压着的那张是什么纸。四样打包成一组
   自定义属性，**真输入框和"正在被揭掉的那张"共用同一份** —— 揭页动画要在飞出去
   的那张纸上原样重现旧纸，两处各写一遍必然分叉：改了纸色忘了改另一处，平时看不出
   来，一按切换当场露馅。

   ⭐ 顺带治好了一个真踩过的坑：原来两种纸抢同一个 ::before（笔记本拿它画页边线、
   稿纸拿它画版心框），而基础规则的 :focus-within 会把它整个填成红色 —— 稿纸那版
   漏写一句 background:transparent，一点进输入框整个版心糊成一块红砖。现在**每种纸
   的 ::before 各自从零声明**，不存在"同一个伪元素被两条规则当两种东西用"。 */
.nd-sheet-design {
  --sheet: var(--paper);
  --sheet-under: var(--aged);
  --rules:    linear-gradient(180deg, transparent 0 28px, rgba(43,33,23,0.17) 28px 29px);
  --rules-on: linear-gradient(180deg, transparent 0 28px, rgba(43,33,23,0.24) 28px 29px);
}
.nd-sheet-rp {
  --sheet: var(--aged);
  --sheet-under: var(--paper);
  --rules:    linear-gradient(180deg, transparent 0 28px, ${P('red',0.16)} 28px 29px);
  --rules-on: linear-gradient(180deg, transparent 0 28px, ${P('red',0.26)} 28px 29px);
}
/* ⚠️ 配方类挂在**整叠**（.ndd-stack）上，不是挂在纸上 —— 页签是纸的兄弟，
   挂在纸上它就继承不到 --sheet，选中那片会变成透明（08-28 真踩到：签只剩红字
   浮在墙上）。正在飞走的那张（.ndd-peel）自己再挂一份**旧**配方，就近覆盖。
   所以下面每种纸的 ::before 都写两条选择器：整叠里当前这张 / 正在飞走的那张。 */

/* ⛔ 纸上印好的东西（页边线、版心框）是**印上去的，不是盖上去的一块玻璃**。
   08-28 真踩到：稿纸那版的版心框 left:34px right:16px top:13px bottom:11px 差不多罩住
   整张纸，而它是伪元素、默认吃指针 —— 于是演出模式下工具栏的「加附件」和「开工」
   全点不着（模型选择器和正文没事，因为那两处自己 position:relative，画在版心框之上）。
   ⚠️ 这条**不按纸分别写**：一种纸一条就等于"以后每加一种纸都要记得补一句"，
   而漏了不报错、只是那张纸上的按钮悄悄失灵。写成对任何配方都成立的一条。 */
.ndd-pad::before, .ndd-peel::before { pointer-events: none; }

/* 笔记本：左边一条红页边线，字写在线右边 */
.nd-sheet-design > .ndd-pad::before,
.ndd-peel.nd-sheet-design::before { content: ''; position: absolute; left: 40px;
  top: 0; bottom: 0; width: 1px; background: ${P('red',0.34)}; }
.nd-sheet-design > .ndd-pad:focus-within::before { background: ${P('red',0.6)}; }
/* 稿纸：书写区整个框进版心，左边那条粗一档 —— 装订侧，跟页边线是同一个位置的东西 */
.nd-sheet-rp > .ndd-pad::before,
.ndd-peel.nd-sheet-rp::before { content: ''; position: absolute; left: 34px; right: 16px;
  top: 13px; bottom: 11px;
  border: 1px solid ${P('red',0.32)}; border-left-width: 2px; }
.nd-sheet-rp > .ndd-pad:focus-within::before { border-color: ${P('red',0.52)}; }
.ndd-pad { position: relative; z-index: 2;
  padding: 26px 24px 16px 58px;
  background-color: var(--sheet); background-image: var(--grain);
  /* 纸堆（2026-08-28）：这不是一张纸，是一叠 —— 底下两张的边从左下角露出来。
     叠里**两种纸交替**，所以第二张是 --sheet-under、第三张又回到 --sheet：
     露出来那一线米黄就是在预告"底下压着另一种纸"，也是切换动画的落点。
     用 box-shadow 画而不是加两个 div：纸的高度是内容撑的，影子自动跟着长。
     顺序 = 从前到后：顶上这张的接触影 → 第二张的纸边 → 它的影 → 第三张 → 它的影，
     最后一层（整叠落在桌上的环境影）写在 box-shadow 里，聚焦时只换那一层。 */
  --stack:
    -1px 2px 3px rgba(93,74,44,0.15),
    -3px 4px 0 -1px var(--sheet-under),
    -3px 4px 2px -1px rgba(93,74,44,0.17),
    -6px 8px 0 -2px var(--sheet),
    -6px 8px 3px -2px rgba(93,74,44,0.15),
    -9px 12px 0 -3px var(--sheet-under),
    -9px 12px 4px -3px rgba(93,74,44,0.13);
  box-shadow: var(--stack), -3px 6px 12px rgba(93,74,44,0.15);
  /* 2026-08-20：模型下拉被下面的项目卡盖住。项目卡的图钉/菜单（.pin/.last/.more/
     .ndd-menu，z 6~9）直接参与 .ndd-in 的层叠、DOM 又在纸后面，于是压过来。
     整叠（.ndd-stack）拿一个高于 9 的层级 —— 纸和卡片在空间上不重叠，只有菜单
     弹出来时才见分晓。歪那 0.35deg 也挪到 .ndd-stack 上：签和纸得一起歪。 */
  transition: box-shadow 0.2s; }
.ndd-pad .clip { position: absolute; top: -14px; left: var(--cx, 18%); width: 18px; z-index: 8;
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
  background-image: var(--rules);
  background-size: 100% 29px; background-position: 0 0; background-attachment: local; }
.ndd-pad textarea.composing { caret-color: var(--red); }
.ndd-pad textarea::placeholder { color: var(--pencil); }
/* 光标之外还得有个状态信号：整张纸没有边框，光靠一根闪的竖线判断"进没进输入态"
   太吃力。聚焦时纸抬起来一档、横线加深、红边线变实 —— 三样一起动，看不错。 */
/* 聚焦只换整叠落在桌上那一层影，纸堆本身（--stack）原样 —— 抬起来的是整叠，
   不是最上面那张自己飘起来 */
.ndd-pad:focus-within { box-shadow: var(--stack), -6px 13px 26px rgba(93,74,44,0.22); }
.ndd-pad:focus-within textarea { background-image: var(--rules-on); }
/* ===== 揭掉最外层那一张（2026-08-28）=====

   用户要的场景：输入栏是一叠无限堆叠的纸，每切一次模式就从最外层揭掉一张。

   做法：切换的那一刻，把**当前这张纸的样子**原地复制一份浮在上面（.ndd-peel），
   让它绕上边缘翻上去飞走；底下露出来的已经是新的那张。复制品直接挂 .ndd-pad +
   配方类，纸色/格线/版心/页签几何**一行都不用重写**，全靠上面那组自定义属性。

   ⚠️ 正文也得跟着走。不带的话切换那一刻正文先消失、480ms 后新 placeholder 才
   出现，比不做动画还糟。所以复制品里画一份静态的字（.lines，高度是切换那一刻
   量到的 textarea 真高）。
   ⚠️ 它不参与交互也不进无障碍树（pointer-events:none + aria-hidden）。
   ⚠️ **签跟纸是一体的**，所以复制品带自己那一片签一起飞；另一片占位不显形，
   让底下真的那片透上来（槽位不变，露出来的是下一张同类纸的签）。
   ⛔ 这条曾经被我自己判错删过一次：把选择器从 .tabs 改名成 .nd-tabs 时漏了下面
   这行，于是复制品把**整对**签都显出来了，看起来像"一对歪着飞的标签"，我当成
   "本来就不该带签"。**改名漏掉一条规则，长得跟设计错误一模一样** —— 下次先查
   选择器还命不命中，再下结论。 */
.ndd-peel .nd-tabs > *:not(.on) { visibility: hidden; }
.ndd-peel { position: absolute; inset: 0; margin: 0; z-index: 6; pointer-events: none;
  box-shadow: ${PAPER_SHADOW.near};
  /* 支点 = 左上角那枚回形针（Clip 的 cx 是 14%，针尖大约再高一点）。
     纸是被针别着的，只能从右边往下扯 —— 绕上边缘往上翻是不讲道理的。 */
  transform-origin: 14% -6px;
  animation: nddPeelOff 520ms cubic-bezier(0.36, 0, 0.3, 1) forwards; }
.ndd-peel .lines { background-image: var(--rules); background-size: 100% 29px;
  background-position: 0 0; overflow: hidden;
  font: 16.5px var(--kai); line-height: 29px; color: var(--ink);
  white-space: pre-wrap; overflow-wrap: break-word; }
.ndd-peel .lines .ph { color: var(--pencil); }
/* 从右边往下扯：先捏住右下角掀起来一点（脱开纸叠），再绕回形针顺时针转下去、
   顺势往右下滑出去。三拍分别是"捏住 / 扯开 / 抽走"。
   rotate 是正的 = 顺时针 = 右边往下沉，跟"从右侧向下拉"的手势一致。 */
@keyframes nddPeelOff {
  0%   { transform: rotate(0deg) translate(0, 0); opacity: 1; }
  14%  { transform: rotate(1.4deg) translate(3px, 2px); opacity: 1; }
  /* 淡出压到后段：早了就成了"半透明的纸盖在新纸上"的双重曝光，
     那不是抽走一张纸，是叠印。要它先真的滑出去，再消失。 */
  62%  { opacity: 0.94; }
  100% { transform: rotate(23deg) translate(96px, 168px); opacity: 0; }
}
/* 关掉动效的人：不演，但还得让 animationend 发出来把复制品收掉 */
@media (prefers-reduced-motion: reduce) {
  .ndd-peel { animation-duration: 1ms; }
}
/* 08-28 一度把这排抬到复制品之上（怕切换那一瞬工具消失半秒），用户判"这些也该
   附着在纸上一起掉下去" —— 对的：它们是写在这张纸上的，不是桌上的家什。
   现在复制品自带一份克隆（见 home-quick-entry.jsx 的 cloneFoot），所以这排照旧
   老老实实待在纸里、被复制品盖住，跟着一起被扯走。
   ⚠️ 别再给它加 z-index 把自己抬出去 —— 抬了就又变成"纸走了工具还钉在原地"。 */
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
  background: var(--ink); color: ${COLOR.btnText};
  border: 1px solid var(--ink); border-radius: 2px; cursor: pointer;
  transition: background 0.18s, color 0.18s, border-color 0.18s; }
.ndd-pad .go:disabled { background: transparent; color: var(--pencil);
  border-color: rgba(43,33,23,0.22); cursor: default; }

/* ===== 分区标题 ===== */
.ndd-head { display: flex; justify-content: space-between; align-items: baseline;
  margin: 44px 0 24px; }
.ndd-head h2 { position: relative; margin: 0; color: var(--desk-ink);
  font: 700 20px var(--kai); letter-spacing: 0.08em; }
.ndd-head h2 svg { position: absolute; left: -2%; bottom: -8px; width: 104%; height: 8px; }
.ndd-head .n { font: 12.5px var(--kai); color: var(--desk-pencil); letter-spacing: 0.06em; }

/* ===== 项目卡：钉在板上的纸 ===== */
.ndd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 36px 28px; }
.ndd-card { position: relative; }
/* 钉子不在纸里 —— 纸被拿起来的时候钉子不该跟着动 */
.ndd-card .pin { position: absolute; top: 3px; left: 50%; width: 9px; height: 9px;
  border-radius: 50%; margin-left: -4.5px; z-index: 6; pointer-events: none;
  background: radial-gradient(circle at 35% 30%, ${PAPER.pinA}, ${PAPER.pinB} 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); }
.ndd-card .pin.r { background: radial-gradient(circle at 35% 30%, ${PAPER.pinRedA}, ${PAPER.pinRedB} 65%); }
/* 卡片的底色跟着这个项目是哪种纸走（.nd-sheet-* 挂在 .ndd-card 上，
   跟输入栏那一叠读的是同一份配方）—— 桌上于是真的混着两种纸，
   而不是靠一枚徽记去说"这个是演出的" */
.ndd-card > a { display: block; position: relative; padding: 15px 14px 12px;
  background-color: var(--sheet); background-image: var(--grain);
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
.ndd-shot { position: relative; width: 100%; overflow: hidden; background: ${PAPER.shot};
  box-shadow: 0 1px 2px rgba(93,74,44,0.22), inset 0 0 0 1px rgba(43,33,23,0.07); }
.ndd-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top;
  display: block; border: 0; }
/* 还没出东西：一张空白的横线纸，不是坏掉的灰块。
   不写字 —— 空白本身就说明了，「还没出东西」那句话由下面那行元信息说一次就够。 */
.ndd-shot.empty {
  background-color: ${PAPER.chrome};
  background-image: repeating-linear-gradient(180deg, transparent 0 21px, rgba(43,33,23,0.05) 21px 22px);
  box-shadow: inset 0 0 0 1px rgba(43,33,23,0.06); }
/* 板书项目的预览：不贴印样，**直接把字写在这张卡的纸上**（板书不是产物，
   进不了封面截图管线）。行高 22px 跟上面那套格线是同一个数 —— 字得坐在格子里，
   差一点就成了"浮在横线上方"（首页那张便签纸 08-21 栽过同一个坑）。
   顶上空一格再落笔：贴着上沿写不像人写的。 */
.ndd-shot.empty.chalk { padding: 22px 13px 0; }
.ndd-shot.empty.chalk p { margin: 0; font: 12.5px var(--kai); line-height: 22px;
  color: ${P('ink2',0.85)}; white-space: pre-line; overflow: hidden;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; }
/* 演出项目那张空白纸是**稿纸**：转旧、红格线、四周一道很淡的版心。
   ⚠️ 这儿不能直接用配方里的 --rules：卡片上的格子是 22px 一行（缩略图的比例），
   输入框是 29px（真行高）。同一种纸、两个尺度，所以颜色抄过来、格高各算各的。 */
.nd-sheet-rp .ndd-shot.empty {
  background-color: ${PAPER.ruled};
  background-image: repeating-linear-gradient(180deg, transparent 0 21px, ${P('red',0.11)} 21px 22px);
  box-shadow: inset 0 0 0 1px ${P('red',0.16)}; }

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
.ndd-menu button.danger:hover { background: ${P('red',0.08)}; }

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
  background: radial-gradient(circle at 35% 30%, ${PAPER.pinA}, ${PAPER.pinB} 65%);
  box-shadow: -1px 2px 3px rgba(43,33,23,0.45); }
.ndd-sheet .h { font: 700 17px var(--kai); letter-spacing: 0.05em; }
.ndd-sheet .d { margin-top: 10px; font: 13.5px var(--kai); line-height: 1.85; color: var(--ink-2); }
.ndd-sheet .chips { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
  margin-top: 22px; }
.ndd-sheet .chips button { padding: 7px 16px; font: 13px var(--kai); color: var(--ink-2);
  background: transparent; border: 1px solid rgba(43,33,23,0.2); border-radius: 999px;
  cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.ndd-sheet .chips button:hover { border-color: var(--ink); color: var(--ink); }
.ndd-sheet .retry { margin-top: 20px; padding: 9px 26px; font: 700 14px var(--kai);
  letter-spacing: 0.24em; text-indent: 0.24em;
  background: var(--ink); color: ${COLOR.btnText}; border: none; border-radius: 2px; cursor: pointer; }
.ndd-quiet { padding: 60px 0; text-align: center; font: 13.5px var(--kai); color: var(--desk-pencil); }

/* ═════════ 窄屏（2026-08-21 移动端适配）═════════
   只动**尺寸**，不动结构：三栏里两侧的板上笔记 1320 以下本来就收掉了，
   剩下的问题全是"照着 1440 的留白排在 393 的屏上"。
   ⚠️ textarea 的 min/max-height 一个都别在这儿改 —— 它们必须是 29 的整数倍
   （见上面横线那一段），改了最后一格会被切一半，而 lint 只看基础规则。 */
@media (max-width: 640px) {
  .ndd { padding: 20px 12px 64px; }
  /* ⚠️ margin-bottom 这儿再写一遍就会盖掉基础规则那份 —— 页签要从纸上沿探出来
     约 26px，给少了它就顶到问候语上（窄屏问候语长、会折行，顶得更明显）。
     由 home-pad.lint.test.js 逐处对。 */
  .ndd-greet { font-size: 21px; letter-spacing: 0.03em; margin-bottom: 30px; }
  /* 纸：左边那条页边留白按比例收，红线跟着挪，不然线压在字上 */
  .ndd-pad { padding: 20px 14px 12px 40px; }
  .ndd-pad::before { left: 26px; }
  /* 页签跟着往里收（右边留白从 30 收到 14），字距也收 —— 窄屏上两片签
     加起来要占掉纸宽的一半就太抢了 */
  .nd-tabs { right: 14px; }
  .nd-tabs > * { padding: 5px 11px 16px; letter-spacing: 0.12em;
    text-indent: 0.12em; }
  /* 工具栏一行排不下就折行；「开工」始终自己占右边。
     ⚠️ 靠中间那根 flex:1 的撑杆把它顶到右边是**碰运气**：撑杆自己也参与折行 ——
     08-29 模型名改短之后撑杆挤进了第一行，开工当场掉到第二行**左端**。
     margin-left:auto 让它在自己那一行里自己贴右，跟撑杆折不折没关系。 */
  .ndd-pad .bar { flex-wrap: wrap; gap: 8px; padding-top: 12px; }
  .ndd-pad .go { padding: 8px 18px; letter-spacing: 0.22em; text-indent: 0.22em;
    margin-left: auto; }
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
