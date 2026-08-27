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

/** 阴影体系 —— 只收编出现 ≥2 次的写法，孤例先留在原地 */
export const SHADOW = {
  crispSm: "0 1px 2px rgba(0,0,0,0.2)",                              // 小徽章/浮点
  crisp:   "0 1px 3px rgba(0,0,0,0.2)",                              // 小浮层
  pop:     "0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",   // 弹出卡
  menu:    "0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",  // 下拉菜单
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
export const FONT_KAI = `'LXGW WenKai ND', 'LXGW WenKai', '霞鹜文楷', ${FONT_EMOJI}, serif`;
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

/** 终端/工具执行深色区（StageLayer 工具卡与 admin 日志同源） */
export const TERM = {
  bg:  "#211e17",
  ink: "#e8e2d2",
  ok:  "#8fc79a",
  err: "#e09a94",
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
export const MODAL = {
  zIndex: 600,
  overlay: "rgba(0,0,0,0.35)",
  blur: "blur(3px)",
  radius: 16,
  width: 340,
  shadow: "0 12px 40px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06)",
  scaleHidden: "scale(0.92) translateY(20px)",
  scaleVisible: "scale(1) translateY(0)",
  transition: "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)",
};

// Stage — Canvas 焕新升级 S2（2026-05-02）：把 iframe 从"贴边平铺"变成
// "浮在暖底上的卡片"。CanvasFrame 用 STAGE.shadow + STAGE.radius，
// ThreeColumnLayout 中间 main 用 STAGE.bg + padding 形成呼吸空间。
export const STAGE = {
  bg: "#F5F0E5",                                  // 台面四周那圈呼吸，比台面浅一档
  shadow: "0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.05)",
  borderWarm: "rgba(190, 160, 130, 0.15)",        // 暖棕极淡边
  radius: 12,
  pad: 12,                                        // stage 周围呼吸（main padding）
};
