/**
 * 树影的**退路**（2026-08-30 起）—— 拿不到 WebGL 时用的那版 CSS 渐变。
 *
 * 现役的光源是 home-canopy.js 里的着色器。这一版留着是因为它不挑机器：
 * 十几个 radial-gradient 叠成一张图整体平移。用户对它的评价是「看起来只是一个
 * 贴图」，这话没错 —— 一张图整体平移，图案之间的关系永远不变，所以调参救不了。
 * 但**有总比没有好**：没有 WebGL 的机器上，一片有光斑的板子仍然比一片死板强。
 *
 * 下面那份性能账是这一版留下的遗产，也解释了它为什么只能每两秒动一格：
 *
 *   初版 scale + 连续动画 ······ 5956ms
 *   去掉 scale ················· 5933ms  ← 几乎没用，问题不在缩放
 *   加 steps(13/11) ············ 1345ms  ← 当时唯一的解法：别每帧都动
 *   steps(8/6) + 去 blend ······  442ms  ← 这一版
 *
 * 着色器版之所以能连续动，是因为这笔钱根本不花在主线程上。
 *
 * ⚠️ 前三轮里有一轮数据是废的：页面当时被注释里一个反引号炸成白屏
 * （CSS 住在 JS 模板字符串里），而量具照样吐出漂亮的数字。所以量具现在会
 * **先断言页面真的渲染了**再开始测。
 */
import { PAPER, P } from '../lib/paper.js';

export const SUN_CSS = `
/* ===== 现役光源：两块画布 =====
 *
 * 底层压在板面之上、内容之下；顶层压在所有内容之上（夜里的暗必须盖住所有东西，
 * 那不是影子，是整个屋子的光少了）。画布内部只有 0.42 倍分辨率 ——
 * 柔光看不出来，放大时的双线性插值反而白送一层柔化。
 */
.ndd-canopy {
  position: fixed; inset: 0; width: 100%; height: 100%;
  display: block; z-index: 0; pointer-events: none;
}
/* ⭐ 950 是压在顶栏（AppShell 的 900）之上。顶栏在这套语言里也是纸（同一套
   颗粒和纸色），屋里的光变暗了它没理由还亮着 —— 只照桌子不照顶栏，夜里
   一眼就看出是贴上去的一层。留在 FloatingPanel（9998）之下。 */
.ndd-canopy.over { z-index: 950; }


/* ===== 树影：晴天，坐在树下那种斑驳的光 =====
 *
 * 两层叶隙光斑各自缓慢漂移，周期 47s / 31s **故意不整除** —— 整除的话叠加图案
 * 会准时重复，读起来就是在放循环动画（登录墙那轮学到的）。
 *
 * ⭐ 只动 transform 和 opacity。这两样走合成层，主线程不重绘不重排；
 *   板面那十四层背景一格都不用重算。08-28 那次首页奇卡的教训是「别把会动的
 *   东西画进随内容长高的容器」，这里的解法是同一条：自己一个视口固定层。
 *
 * ⚠️ mix-blend-mode 挂在**外层**不挂在子层：子层自己有 transform，会开新的
 *   层叠上下文，混合就够不着底下的板面了（涂鸦那次踩过一模一样的坑）。
 *
 * 光斑的颜色取当季的光（--lit / --lit-soft 走 season.js）：夏天冷白、秋天金黄，
 * 树影跟着季节一起变 —— 季节管光是什么颜色，这一层管光怎么落下来。
 */
.ndd-sun {
  position: fixed; inset: -12%; z-index: 0; pointer-events: none;
  contain: strict;
}
.ndd-sun i {
  position: absolute; inset: 0; display: block;
  will-change: transform;
}
/*
 * ⭐ 树影不是「往板子上打几个亮点」。真站在树下，**大部分面积是叶子的影**，
 * 光是从叶隙漏下来的少数。所以两层的分工是：
 *   第一层  = 影（大块、压暗、疏）+ 漏下来的几束光
 *   第二层  = 细碎的叶隙光（密、小、亮）
 * 第一版只画了亮斑、还套了 soft-light，结果整幅只有 1.1% 的像素在变，
 * 肉眼完全看不出来 —— 缺的正是暗的那一半。
 */
.ndd-sun i:nth-child(1) {
  background:
    /* 叶子的影：压暗，大块，边缘很软 */
    radial-gradient(ellipse 34% 28% at 12% 18%, ${P('dusk', 0.14)}, transparent 72%),
    radial-gradient(ellipse 30% 34% at 78% 8%, ${P('dusk', 0.12)}, transparent 74%),
    radial-gradient(ellipse 38% 26% at 92% 62%, ${P('dusk2', 0.10)}, transparent 72%),
    radial-gradient(ellipse 26% 32% at 34% 88%, ${P('dusk', 0.11)}, transparent 74%),
    /* 漏下来的那几束：亮，边缘比影硬一点 */
    radial-gradient(ellipse 16% 12% at 26% 34%, ${P('lit', 0.85)}, transparent 66%),
    radial-gradient(ellipse 11% 18% at 60% 20%, ${P('lit', 0.72)}, transparent 68%),
    radial-gradient(ellipse 19% 11% at 84% 40%, ${P('litSoft', 0.66)}, transparent 64%),
    radial-gradient(ellipse 9% 15% at 45% 62%, ${P('lit', 0.6)}, transparent 70%),
    radial-gradient(ellipse 14% 11% at 9% 74%, ${P('litSoft', 0.52)}, transparent 68%),
    radial-gradient(ellipse 17% 14% at 70% 86%, ${P('lit', 0.46)}, transparent 70%);
  animation: nddSunA 47s steps(8, jump-none) infinite;
}
/* 细碎叶隙：密、小、亮 —— 风一动最先闪的是这一层 */
.ndd-sun i:nth-child(2) {
  background:
    radial-gradient(ellipse 6% 4.5% at 31% 18%, ${P('lit', 0.8)}, transparent 62%),
    radial-gradient(ellipse 4.5% 7% at 52% 33%, ${P('lit', 0.7)}, transparent 66%),
    radial-gradient(ellipse 7% 5% at 77% 21%, ${P('litSoft', 0.62)}, transparent 64%),
    radial-gradient(ellipse 4% 6% at 22% 47%, ${P('lit', 0.58)}, transparent 68%),
    radial-gradient(ellipse 8% 4.5% at 68% 61%, ${P('litSoft', 0.54)}, transparent 62%),
    radial-gradient(ellipse 5% 7.5% at 44% 78%, ${P('lit', 0.5)}, transparent 66%),
    radial-gradient(ellipse 4.5% 5% at 89% 52%, ${P('lit', 0.46)}, transparent 64%),
    radial-gradient(ellipse 6% 6% at 12% 88%, ${P('litSoft', 0.42)}, transparent 66%),
    radial-gradient(ellipse 5% 4% at 58% 8%, ${P('lit', 0.44)}, transparent 62%),
    radial-gradient(ellipse 4% 5.5% at 95% 78%, ${P('litSoft', 0.38)}, transparent 66%);
  animation: nddSunB 31s steps(6, jump-none) infinite;
}
/* 位移量很小（几个百分点）：树影是风吹叶子在晃，不是探照灯扫过去。
 *
 * ⛔⛔ **只许 translate，不许 scale。** 第一版两条 keyframes 里各带了一点
 * 一点 scale(1.03)，想让光斑"胀一下缩一下" —— 实测主线程从 42ms 涨到 5578ms
 * （**132 倍**）。缩放会让浏览器按新尺寸重新光栅化整层背景，而这一层是七到十个
 * 大面积 radial-gradient，每帧重画一遍。位移不会：它就是把已经栅格化好的那张
 * 图挪个位置。
 *
 * 「胀缩」的手感改用**两层不同方向的位移叠加**来换 —— 两片影子交错走过，
 * 明暗此消彼长，看起来就是在呼吸，而且不花钱。
 * （同族教训：08-28 那次是 background-attachment:fixed，比不改差 12 倍。
 *   这一层上「看起来省事的 CSS 属性代价极高」已经是第二次了。）
 *
 * ⛔ 去掉 scale **还不够**：连续位移照样把主线程从 66ms 顶到 5933ms —— 每一帧
 * 都要按新位置把整层七到十个大渐变重栅格一遍。真正的解法是**别每帧都动**：
 * 树影的周期是 47 秒，本来就不需要 60fps。
 *
 * steps() 让它离散跳 —— 每 ~2 秒挪一格。柔和的大光斑上肉眼看不出跳格，
 * 而"风偶尔吹一下"本来就该是这个节奏（跟登录墙那套定格轮播是同一个语言，
 * 只是这里的动机是性能）。
 * ⚠️ steps() 是按**每两个关键帧之间**算的：下面每条 keyframes 有四个关键帧、
 * 三段区间，所以 steps(8) 实际是 24 格（登录墙那次栽过，格数被悄悄乘了 3）。
 */
@keyframes nddSunA {
  0%   { transform: translate3d(0, 0, 0); }
  33%  { transform: translate3d(1.8%, 1.2%, 0); }
  66%  { transform: translate3d(-1.2%, 2.2%, 0); }
  100% { transform: translate3d(0, 0, 0); }
}
@keyframes nddSunB {
  0%   { transform: translate3d(0, 0, 0); }
  40%  { transform: translate3d(-2.6%, -1.6%, 0); }
  75%  { transform: translate3d(1.5%, -0.9%, 0); }
  100% { transform: translate3d(0, 0, 0); }
}
/* 落在纸上的那一半：压在内容之上，只留亮的、且淡得多。
   不给它暗斑 —— 影子压在正文上是把纸弄脏，不是打光。

   ⛔ 不用 mix-blend-mode：它压在**整个内容之上**，光斑每跳一格就要把整页重新
   混合一遍，实测多花 305ms。改成很淡的普通叠加，观感差别很小，代价差一档。 */
.ndd-sun.over {
  z-index: 2;
  opacity: 0.5;
}
.ndd-sun.over i:nth-child(1) {
  background:
    radial-gradient(ellipse 16% 12% at 26% 34%, ${P('lit', 0.95)}, transparent 66%),
    radial-gradient(ellipse 11% 18% at 60% 20%, ${P('lit', 0.85)}, transparent 68%),
    radial-gradient(ellipse 19% 11% at 84% 40%, ${P('litSoft', 0.8)}, transparent 64%),
    radial-gradient(ellipse 9% 15% at 45% 62%, ${P('lit', 0.72)}, transparent 70%),
    radial-gradient(ellipse 14% 11% at 9% 74%, ${P('litSoft', 0.62)}, transparent 68%),
    radial-gradient(ellipse 17% 14% at 70% 86%, ${P('lit', 0.56)}, transparent 70%);
}

/* 手机上收一层：小屏本来就看不出叶隙的疏密，留一层够了 */
@media (max-width: 640px) {
  .ndd-sun i:nth-child(2) { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ndd-sun i { animation: none; }
}

`;
