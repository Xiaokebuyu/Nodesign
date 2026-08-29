// ─── 基础 Token ───────────────────────────────────
//
// 2026-08-03 第一步（立法）：值一律不动，把散落在组件里的字面量收编成单一数据源。
// 2026-08-03 第二步（换肤）：**只改这个文件的值**，组件一行不动。
//
//   登录墙和首页定了一套物料：暖纸、墨字、铅笔灰、红笔。lib/paper.js 是那套物料
//   的定义。这里做的事就是把基础色系整体挪进同一个色族 —— 全站 110 处 bgWhite、
//   191 处 border、269 处 FONT_SANS 因此一次性归位，不用去改 50 个组件。
//
//   两条口径，改之前先读：
//   1) 白 → 纸。全站没有纯白，最亮的是 #FFFEF6。
//   2) 中性灰 → 暖墨。所有 rgba(0,0,0,x) 的描边换成 rgba(43,33,23,x)。
//
//   字体的分工是**有意义的**，不是没统一：楷体 = 人写的（正文、标题、按钮），
//   等宽 = 机器写的（文件名、id、token 数、终端输出）。登录墙上那张终端墨版和
//   用量小票用的就是等宽，那是同一条规矩。所以 FONT_SANS 指向楷体，FONT_MONO
//   保持等宽 —— 剩下的活是把**当标题用**的 FONT_MONO 挪去楷体。

/** 颜色体系 —— 值取自 lib/paper.js 那套物料（PAPER.*） */
export const COLOR = {
  // 文字层级（从深到浅）：墨 → 铅笔
  text:   "#2B2117",   // 主标题/主文字（= PAPER.ink）
  text2:  "#4A3E31",   // 正文
  text3:  "#5F5142",   // 表单标签（= PAPER.ink2）
  text4:  "#7A6B57",   // 三级文字/图表标签
  text5:  "#8C7E68",   // 导航/图标默认
  sub:    "#A39882",   // 辅助说明/时间戳（= PAPER.pencil）
  dim:    "#C3B9A4",   // 禁用/占位符

  // 背景：没有纯白，最亮的是纸
  bg:         "#F4EFE3",   // App 根背景（比纸深，比板子浅）
  bgModal:    "#FFFEF6",   // 弹窗/表单（= PAPER.paper）
  bgCard:     "#F3EDDF",   // 卡片凹槽/占位底
  bgWhite:    "#FFFEF6",   // 纸。名字保留是因为 110 处在用，语义已经是"纸"

  // 渐变
  gradModal: "linear-gradient(180deg, #FFFEF6 0%, #FFFEF6 30%)",

  // 交互
  btn:      "#2B2117",
  btnHover: "#443627",
  btnText:  "#F5F0E4",

  // 边框：暖墨的淡痕，不是中性黑
  border:   "rgba(43,33,23,0.09)",
  borderLt: "rgba(43,33,23,0.06)",
  borderMd: "rgba(43,33,23,0.13)",
  borderHv: "rgba(43,33,23,0.20)",

  // 状态
  error:   "#A8362B",   // = PAPER.red
  success: "#4F7F4A",
  warn:    "#A8641F",

  // 强调
  blue:  "#5A748F",
  brown: "#8A6A3A",
  gold:  "#C4A870",
};

/**
 * alpha('#b08c4f', 0.3) → 'rgba(176,140,79,0.3)'
 * 半透明变体一律从实色 token 派生，别再手写第二份 rgba。
 */
export function alpha(hex, a) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 间距体系（px） */
export const GAP = {
  xxs: 2, xs: 4, sm: 6, md: 8, base: 10, lg: 12, xl: 16, xxl: 20, page: 40,
};

/**
 * 圆角体系（px）。
 *
 * 2026-08-03 换肤整体收窄：这套语言里最大的实体是**纸**，纸没有圆角。登录墙上
 * 那张登记卡是直角，它的按钮和印章是 2~3px。原来那套 6/8/10/12 是「网页卡片」
 * 的手感，压在纸上就是两种材质打架 —— 他看到的「卡片风格没统一」就是这个。
 * 胶囊和圆点不动（那是形状不是圆角）。
 */
export const RADIUS = {
  // 卡片这一档归零：纸没有圆角。小控件（按钮、chip、输入框）留 2px ——
  // 登录墙上那个「进 门」墨块和那枚印章就是 2~3px，刀切纸的边也不是绝对的直角。
  xs: 2, sm: 2, md: 2, lg: 2, xl: 0, xxl: 0,
  pill: 999,
  round: '50%',
};

/**
 * 阴影体系 —— 只收编出现 ≥2 次的写法，孤例先留在原地。
 *
 * 2026-08-29 暖化：这一组原来是 `rgba(0,0,0,x)`，而 paper.js 的 PAPER_SHADOW 用的是
 * 暖褐 `rgba(93,74,44,x)` —— **同一件事（东西压在纸上的影子）两份算法**，于是站点上
 * 一直有两种影子：纸族的是暖的，弹窗菜单那族是灰的，压在同一张暖纸上后者发闷。
 * 统一到暖褐这一份，alpha 上浮约一成补回亮度差（#5D4A2C 相对亮度 ≈0.075，
 * 在纸底上同 alpha 会比纯黑淡那么一点）。
 *
 * ⚠️ 这是**颜色**的收编，不是形状的。各组件里手写的 `0 8px 24px …` 那些没有改成
 * 引用本组 —— 那是另一件事，改形状要逐处看层级，值的统一先落地。
 */
const SH = (a) => `rgba(93,74,44,${a})`;
export const SHADOW = {
  crispSm: `0 1px 2px ${SH(0.22)}`,                          // 小徽章/浮点
  crisp:   `0 1px 3px ${SH(0.22)}`,                          // 小浮层
  pop:     `0 8px 24px ${SH(0.13)}, 0 2px 6px ${SH(0.07)}`,   // 弹出卡
  menu:    `0 12px 32px ${SH(0.13)}, 0 2px 6px ${SH(0.07)}`,  // 下拉菜单
};

/** 字号体系（px）。xxs=9 是实际存在的第 10 号字级（此前 29 处硬写） */
export const FONT_SIZE = {
  xxs: 9, xs: 10, sm: 11, md: 12, base: 13, lg: 14, xl: 15, xxl: 16, h2: 17, h1: 20,
};

// ─── Font Families ────────────────────────────────

// 楷体：全站正文。@font-face 在 styles/globals.css，全局只声明一次
// emoji 回落（2026-08-25 板书豆腐块案）：楷体/龙藏都没有 emoji 字形，栈里不列
// emoji 字体的话 🎲✅⏳ 全渲成豆腐块 —— 挂在 serif 之前，只接管 emoji 码位。
export const FONT_EMOJI = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";
// 'LXGW WenKai Screen' 排在本地装的那两个名字后面、serif 前面（2026-08-29）：
// ND 是我们自己切的两级字集（首屏 52KB + 全站 220KB，覆盖 web/src 里所有会上屏的
// 汉字），用户自己打的字（项目名、文件名）超出去的由 Screen 兜住 —— 它是 npm 包
// 按需分片的全量字库，**不兜的话就直接掉到系统宋体**，一行里楷体宋体混排。
// ⚠️ Screen 是另一刀：实测墨量比 Regular 重 20%（跟 Bold 一个量级），所以只当最后
// 一道网，不当主力；界面文案要留在 ND 里（font-subset.lint.test.js 钉着覆盖率）。
export const FONT_KAI = `'LXGW WenKai ND', 'LXGW WenKai', '霞鹜文楷', 'LXGW WenKai Screen', ${FONT_EMOJI}, serif`;
// 阅读体（08-27）：屏幕优化版文楷，**全量字库**按需分片加载 —— 板书/长文正文用它；
// 门面字（标题/UI）仍走 FONT_KAI（52KB 子集秒显）。
export const FONT_READ = `'LXGW WenKai Screen', 'LXGW WenKai ND', '霞鹜文楷', ${FONT_EMOJI}, serif`;
// 等宽：**机器写的东西**才用（文件名、id、token 数、终端输出、时间码）
export const FONT_MONO = "'SF Mono', 'Cascadia Code', 'Menlo', monospace";
// FONT_SANS 指向楷体：269 处正文因此一次性归位。名字保留是为了不动那 269 个调用点，
// 新代码直接写 FONT_KAI。真需要无衬线的地方（目前没有）再单开一个 token。
export const FONT_SANS = FONT_KAI;

/**
 * 外壳（顶栏）—— 2026-08-03 换肤第一块。
 *
 * 原来是纯白条 + 冷灰描边，压在暖纸色的页面上像贴了条胶带。整条改成纸色，
 * 描边换成墨色的淡痕。顶栏是全站唯一横跨所有路由的构件，值一动全站跟着动，
 * 所以收在这儿而不是散在 TopBar 里。
 */
export const CHROME = {
  bg:     "#FBF7EC",
  border: "rgba(43,33,23,0.13)",
  ink:    "#2B2117",
  ink2:   "#5F5142",
  pencil: "#A39882",
  hover:  "rgba(43,33,23,0.055)",
};

// ─── 领域 Token ───────────────────────────────────

/**
 * 终端/工具执行深色区（StageLayer 工具卡与 admin 日志同源）。
 *
 * 2026-08-29 扩充：原来只有四个值，而深色卡实际用着十几个 —— 边框、图标、
 * 三种状态的字和底全硬写在 StageLayer 里。压在深色上的状态色跟压在纸上的
 * 不是同一档（纸上那套在墨底上会糊掉），所以它们是 TERM 的成员而不是
 * COLOR.error/success 的复用。
 */
export const TERM = {
  bg:  "#211e17",
  ink: "#e8e2d2",
  ok:  "#8fc79a",
  err: "#e09a94",
  /** 卡的边框：跑挂了 / 跑通了 */
  edgeErr: "#b0554f",
  edgeOk:  "#4f8f5b",
  /** 卡头那枚图标 */
  icon:    "#c8b98c",
  /** 报错条：底用边框色加透，字比它亮一档 */
  errText: "#dba49f",
  /** 跑完 / 正在跑 的字 */
  okText:  "#cfe3cf",
  runText: "#d9e4c9",
  /** 深色卡自己的投影（比纸的影子更沉） */
  shade:   "#282010",
};

/**
 * 工作台外壳（2026-08-03 换肤第二块）—— 三栏的底色和分界。
 *
 * 物理逻辑：首页那面板子上钉着所有项目，进到工作台等于把其中一张取下来摊在台面上。
 * 所以左右两栏跟顶栏是同一张纸（外壳是连续的），中间那片是台面 —— 比纸深一档，
 * 白色的产物摊上去才浮得起来。
 */
export const WORKBENCH = {
  panel: "#FBF7EC",                  // 左右两栏：与 CHROME.bg 同色，外壳连成一片
  edge:  "rgba(43,33,23,0.13)",      // 栏与栏之间那道墨痕
};

/** 画布工作面专属（暖纸方言；换肤时整组处置） */
export const CANVAS = {
  paper: "#EBE5D7",   // 台面（比纸深一档，产物浮在它上面）
  note:  "#FBF3CF",   // 便签黄（与板上那些便签同色）
  brass: "#b08c4f",   // 暖棕描边/运行态（半透明用 alpha(CANVAS.brass, x)）
  grid:  "rgba(72,55,32,0.10)",   // 台面上的定位点
};

/** 画布交互层（拖拽/评论/对齐等 Figma 式高饱和工具色）。
 *  名字按色相取——语义映射（哪个功能用哪色）留给换肤阶段重整。 */
export const EDITOR = {
  blue:    "#3a7afe",   // 光标/手柄
  magenta: "#e91e63",   // 对齐参考线
  orange:  "#e67e22",   // 评论锚点
  purple:  "#9c4dcc",   // 待定移动
  teal:    "#14b8a6",   // 测量/工具条高亮
  green:   "#16a34a",   // 成功闪现
  violet:  "#8b5cf6",   // 聚焦环
};

/** 顶部横幅三态（QuotaBanner 与 AdminConsole 公告预览共用） */
export const BANNER = {
  info:  "rgba(42, 88, 133, 0.96)",
  warn:  "rgba(184, 92, 26, 0.96)",
  alert: "rgba(184, 58, 42, 0.96)",
};

// ─── 组件级 Token ─────────────────────────────────

// Detail modal — 锚定 SkillDetail
// 2026-08-29：遮罩和影子跟着 SHADOW 一起暖化。遮罩用 PAPER.scrim 同一个值
// （墨加透，不是中性黑）—— 压暗一张暖纸用中性黑会把它压成灰的。
export const MODAL = {
  zIndex: 600,
  overlay: "rgba(43,33,23,0.38)",
  blur: "blur(3px)",
  radius: 16,
  width: 340,
  shadow: `0 12px 40px ${SH(0.13)}, 0 4px 12px ${SH(0.07)}`,
  scaleHidden: "scale(0.92) translateY(20px)",
  scaleVisible: "scale(1) translateY(0)",
  transition: "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)",
};

// Stage — Canvas 焕新升级 S2（2026-05-02）：把 iframe 从"贴边平铺"变成
// "浮在暖底上的卡片"。CanvasFrame 用 STAGE.shadow + STAGE.radius，
// ThreeColumnLayout 中间 main 用 STAGE.bg + padding 形成呼吸空间。
export const STAGE = {
  bg: "#F5F0E5",                                  // 台面四周那圈呼吸，比台面浅一档
  shadow: `0 8px 32px ${SH(0.11)}, 0 2px 8px ${SH(0.06)}`,
  borderWarm: "rgba(190, 160, 130, 0.15)",        // 暖棕极淡边
  radius: 12,
  pad: 12,                                        // stage 周围呼吸（main padding）
};
