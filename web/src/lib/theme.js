// ─── 基础 Token ───────────────────────────────────

/** 颜色体系 */
export const COLOR = {
  // 文字层级（从深到浅）
  text:   "#3a2a18",   // 主标题/主文字
  text2:  "#4a4540",   // 正文
  text3:  "#5a5550",   // 表单标签
  text4:  "#7a6a55",   // 三级文字/图表标签
  text5:  "#8a7a62",   // 导航/图标默认
  sub:    "#a09888",   // 辅助说明/时间戳
  dim:    "#c4bfb5",   // 禁用/占位符

  // 背景
  bg:         "#F9F8F6",   // App 根背景
  bgSide:     "#F3F2EE",   // 侧边栏
  bgModal:    "#FDFCFA",   // 弹窗/表单
  bgCard:     "#f6f1ea",   // 卡片
  bgSkeleton: "#f2efe9",   // 骨架屏底
  bgSkBar:    "#e8e4de",   // 骨架屏条
  bgWhite:    "#fff",

  // 渐变
  gradModal: "linear-gradient(180deg, #fdfcfa 0%, #fff 30%)",
  gradDesk:  "linear-gradient(180deg, #ede8e0, #e8e2d8)",

  // 交互
  btn:      "#2d2418",
  btnHover: "#3d3428",
  btnText:  "#f5f0e8",

  // 边框
  border:   "rgba(0,0,0,0.06)",
  borderLt: "rgba(0,0,0,0.04)",
  borderMd: "rgba(0,0,0,0.08)",
  borderHv: "rgba(0,0,0,0.12)",

  // 状态
  error:   "#b83a2a",
  success: "#4a8a4a",
  warn:    "#b85c1a",
  plan:    "#3a6a3a",

  // 强调
  blue:  "#5a7a9a",
  brown: "#8a6a3a",
  gold:  "#c4a870",
};

/** 间距体系（px） */
export const GAP = {
  xs: 4, sm: 6, md: 8, base: 10, lg: 12, xl: 16, xxl: 20, page: 40,
};

/** 字号体系（px） */
export const FONT_SIZE = {
  xs: 10, sm: 11, md: 12, base: 13, lg: 14, xl: 15, xxl: 16, h2: 17, h1: 20,
};

// ─── Font Families ────────────────────────────────

// Font families — Dashboard 基准
export const FONT_MONO = "'SF Mono', 'Cascadia Code', 'Menlo', monospace";
export const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";

// ─── 组件级 Token ─────────────────────────────────

// Card shell — 锚定 SkillCard
export const CARD = {
  w: 126,
  h: 164,
  radius: GAP.lg,
  bg: COLOR.bgCard,
  bgHover: "#faf7f2",
  border: `1px solid ${COLOR.border}`,
  borderHover: `1px solid ${COLOR.borderHv}`,
  shadow: "0 1px 4px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04)",
  shadowHover: "0 12px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)",
  transition: "all 0.35s cubic-bezier(0.25, 1, 0.5, 1)",
  hoverY: -10,
  hoverScale: 1.04,
  padding: `${GAP.base}px ${GAP.base}px ${GAP.md}px`,
};

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

// DeskRow — 锚定 Dashboard DeskRow
export const DESK = {
  height: 200,
  radius: 14,
  bg: COLOR.gradDesk,
  borderClosed: "1px solid rgba(0,0,0,0.05)",
  borderOpen: `1px solid ${COLOR.border}`,
  shadowClosed: "0 1px 4px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.4)",
  shadowOpen: "0 4px 16px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.5)",
  infoLeft: "1px dashed rgba(0,0,0,0.05)",
  lines: [40, 85, 130, 170],
  maxHand: 7,
  cardW: 126,
  stackY: 18,
};

// FullPanel — Container Transform 动画壳（第三层）
export const PANEL = {
  zIndex: 700,
  bg: COLOR.bgWhite,
  radius: 20,
  shadow: "0 20px 60px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08)",
  overlay: "rgba(0,0,0,0.3)",
  transition: "all 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
};

// Browse page — 锚定 CardBrowse
export const BROWSE = {
  backRadius: 10,
  backPadding: "7px 14px",
  backFontSize: 13,
  backFontWeight: 500,
  backColor: COLOR.text5,
  searchBg: "#fff",
  searchRadius: 12,
  searchFontSize: 14,
  gridMin: 128,
};
