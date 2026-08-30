/**
 * 桌面（.ndd）—— 站点的那张台面，加上照在它上面的光。
 *
 * 2026-08-30 从 home-styles.js 原样搬出来的：用户报「橱窗和 Skill 页没用上
 * 首页的样式和光线」。那两页本来直接坐在一片平涂的米色上，既没有板面纹理，
 * 也没有树影和白天黑夜 —— 因为整套东西过去只写在首页那一个组件里。
 *
 * ⭐ 搬出来但**没有搬第二份**：home-styles.js 的 CSS 里仍然拼着这一段
 * （所以 home-surface / home-pad 两条 lint 照旧读得到），首页把整份传给
 * <Desk css={CSS}>，另外两页什么都不传、只吃这一份。
 *
 * ⛔ 台面那十四层是 position: fixed 的视口层，不是铺满 .ndd —— 理由在下面的
 *    长注释里，别改回去（改回去首页项目一多就会重新变卡）。
 */
import { PAPER_VARS, P } from '../lib/paper.js';
import { SUN_CSS } from './home-sun.js';
import { Canopy } from './home-light.jsx';

export const DESK_CSS = `
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
    radial-gradient(ellipse 80% 40% at 50% -6%, ${P('lit',0.55)}, transparent 62%),
    radial-gradient(ellipse 44% 22% at 10% 16%, ${P('dusk',0.05)}, transparent 72%),
    radial-gradient(ellipse 40% 20% at 90% 42%, ${P('dusk',0.045)}, transparent 74%),
    radial-gradient(ellipse 34% 18% at 26% 70%, rgba(93,74,44,0.04), transparent 72%),
    radial-gradient(ellipse 30% 16% at 78% 92%, ${P('litSoft',0.4)}, transparent 72%),
    var(--grain),
    repeating-linear-gradient(0deg, rgba(43,33,23,0.02) 0 1px, transparent 1px 28px),
    repeating-linear-gradient(90deg, rgba(43,33,23,0.02) 0 1px, transparent 1px 28px),
    radial-gradient(circle at 37px 51px, ${P('hole',0.15)} 0 1.1px, transparent 1.7px),
    radial-gradient(circle at 119px 23px, ${P('hole',0.12)} 0 1px, transparent 1.6px),
    radial-gradient(circle at 61px 137px, ${P('hole',0.1)} 0 1.2px, transparent 1.8px),
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

${SUN_CSS}

.ndd-in { position: relative; z-index: 1; max-width: 1400px; margin: 0 auto; }
`;

/**
 * 把内容摆到台面上。
 *
 * 光源层必须是 .ndd 的**直接子节点**（两块画布靠 z-index 分前后：一块压在板面
 * 之上内容之下，一块压在所有内容之上），所以它在这儿挂，不在调用方手里。
 *
 * @param {string} [css] 这一页额外的样式。首页把自己那一整份传进来（里面已经
 *   拼着 DESK_CSS）；不传就只上台面这一份。
 */
export function Desk({ css, children }) {
  return (
    <div className="ndd">
      <style>{css || DESK_CSS}</style>
      {/* 光源层（树影 / 台灯）。两块画布：一块压在板面之上内容之下，一块压在
          所有内容之上，靠 z-index 分前后。
          ⛔ 必须是**独立的 fixed 层**，不能并进 .ndd::before 那十四层 ——
          那一层是静态的，掺进动画就等于每帧重画十四层背景，正是
          08-28「项目一多就奇卡」的病根。 */}
      <Canopy />
      <div className="ndd-in">{children}</div>
    </div>
  );
}
