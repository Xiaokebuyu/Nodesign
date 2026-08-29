/**
 * 纸物料 —— 登录墙（AuthGate）和首页桌面（Home）共用的一套材质。
 *
 * 两个页面画的是同一个世界里的纸：字体、纸色、颗粒噪声、阴影分档必须是同一份，
 * 不然同一件东西在两页会有两种手感。这里只放**材质**，不放布局 ——
 * 墙是 1500x800 的固定设计稿，桌面是可滚动的真实数据流，构图规则本就不同。
 *
 * 用法：把 PAPER_VARS 塞进页面根选择器。
 *   const CSS = `.myroot { ${PAPER_VARS} ... }`;
 * 楷体的 @font-face 在 styles/globals.css，全局声明一次（顶栏也要用）。
 *
 * 光向全站统一：右上打光 → 影子一律偏左下（-x, +y）。三档影子见 PAPER_SHADOW。
 */

import { FONT_KAI, alpha } from './theme.js';

/** 纸面颗粒：140px 一格的 fractalNoise，压得很淡，只是让纯色不那么塑料 */
export const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0.17 0 0 0 0 0.13 0 0 0 0 0.06 0 0 0 0.1 0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")`;

/**
 * 纸物料的实色。写 inline style 的组件（弹窗那一族）从这里取；
 * 写 CSS 字符串的页面用下面 PAPER_VARS 里的同名变量 —— 两边同一份值。
 */
export const PAPER = {
  wall:   '#F0EADB',
  paper:  '#FFFEF6',
  legal:  '#FAF0C6',
  kraft:  '#E2D3B4',
  sticky: '#FBF3CF',
  /** 旧稿纸：演出那张纸的底色。比 paper 黄一档、比 legal 收敛得多 ——
   *  它得一眼看出"不是刚才那张"，又不能变成一本便签簿。 */
  aged:   '#FAF2DC',
  ink:    '#2B2117',
  ink2:   '#5F5142',
  pencil: '#A39882',
  hair:   'rgba(43,33,23,0.22)',
  red:    '#A8362B',
  /** 弹窗背后那层压暗：暖的，不是中性黑 */
  scrim:  'rgba(43,33,23,0.38)',

  // ── 板面的光与暗（2026-08-29 收编）────────────────────────────
  //
  // 这几个值原来硬写在 home-styles.js 和 wall-css.js 的 radial-gradient 里，
  // 一共 20 多处。收进来的理由不是整洁，是**季节化就是换光**：一年四季纸差不多，
  // 差的是打在纸上的光什么颜色、多硬。它们必须能被一处改掉。
  //
  // ⚠️ 值一个都没动，收编时用 alpha() 插值输出的字符串跟原来逐字节相同 ——
  // 登录墙有逐像素守门，这一轮必须 diff=0。
  /** 板面主光斑：右上那道暖白 */
  lit:    '#FFF7E1',
  /** 次级光斑：更淡更黄的那几处 */
  litSoft:'#FFF6DA',
  /** 斜窗光：登录墙板面上那道更饱和的暖光 */
  litWarm:'#FFD282',
  /** 斜切进来的那道窗光 */
  litSlant:'#FFF4D2',
  /** 反光高光：钉子和纸边上那点冷白 */
  litCool:'#FFFCF0',
  /** 板面暗斑：让板子不是匀色的那几团 */
  dusk:   '#7A6038',
  /** 更沉的暗角（登录墙底边） */
  dusk2:  '#503E28',
  /** 旧钉眼 */
  hole:   '#483720',

  // ── 纸的变体 ─────────────────────────────────────────────
  /** 缩略图/封面占位底：比纸深、比板浅 */
  shot:   '#EFEAE0',
  /** 顶栏与横线本的纸（= CHROME.bg，同一张纸） */
  chrome: '#FBF7EC',
  /** 横线纸/稿纸底 */
  ruled:  '#FBF4E2',
  /** 垫在后面露一条边的那张空纸 */
  stack:  '#F8F3E7',

  // ── 纸材的内部构造色（2026-08-29 收编）────────────────────
  //
  // 这一组原来在 login-wall/scenes 的三个场景文件里**各写了一遍**：方格纸的格线、
  // 终端墨版的底与字、描图纸、索引卡……全是同样的值。wall-css.js 的文件头写着
  // 「能共用的是材质，不是坐标」，可材质色恰恰散在坐标那一层，成了三份副本。
  // 收进来之后加一张纸只需引用，不用再抄一遍色号。
  //
  // ⚠️ 终端这几个跟 theme.js 的 TERM 是**两套值**（那边是画布工具卡，这边是墙上
  // 那张终端纸）。记忆里说它们「同源」，但值确实不同 —— 先各自收编，要不要合并
  // 是另一次决定，合并会动登录墙的逐像素基线。
  /** 方格纸的格线（全站唯一一处冷色纸材） */
  gridLine: '#4A6B8F',
  /** 终端墨版：底的渐变两端 */
  termA:  '#2b2318', termB: '#241d14',
  /** 终端墨版：正文 / 次要 / 标签 / 成功 */
  termInk: '#E4DCC8', termDim: '#8A8069', termLabel: '#9b917c', termOk: '#9DBF9A',
  /** 终端里那道分隔线（正文色的淡痕） */
  termHair: '#E4DCC8',
  /** 索引卡 / 牛皮签 */
  index:  '#E9D8BB',
  /** 描图纸：半透明的纸和它上面的字 */
  trace:  '#F3F1E6', traceInk: '#3C3226',
  /**
   * 板上的那支笔 —— 手绘引线和直接写在板面上的字（不带纸的那些）用同一支。
   * 四档深浅原来在 home-styles.js 和 wall-css.js **各写了一遍**，同样的四个值：
   * 首页的铅笔账和登录墙的板上字本来就是同一只手写的，只是没人把它收成一份。
   */
  sketch:     '#7A6F5C',   // 正文
  sketchDeep: '#685D4C',   // 标题那一行
  sketchSoft: '#827763',   // 旁注
  sketchNum:  '#8C7F68',   // 账目里的数字
  /** 没选中那片页签上的字（牛皮色底，比板上的字再深一点） */
  tabInk:     '#605440',

  // ── 物件（不随季节走：铜和塑料不换季）──────────────────────
  /** 图钉：受光面 → 背光面 */
  pinA:   '#8a7a62', pinB: '#453a2c',
  /** 红图钉（最近动过的那张纸） */
  pinRedA:'#b4544a', pinRedB: '#7d241c',
  /** 长尾夹 */
  clipA:  '#b9b2a4', clipB: '#6f6759',
};

/**
 * 板面/纸物料的半透明变体：`P('lit', 0.55)` → `rgba(255,247,225,0.55)`。
 *
 * 这些 CSS 全都住在 JS 模板字符串里，所以走插值而不是再加一层 CSS 变量 ——
 * 少一层间接，且换季时改 PAPER 的值，所有插值点自动跟着走。
 * （季节是在模块加载时按日期定的，不需要运行时切换，所以不需要 CSS 变量那条路。）
 */
export const P = (name, a) => alpha(PAPER[name], a);

export const PAPER_VARS = `
  --wall: ${PAPER.wall};
  --paper: ${PAPER.paper};
  --legal: ${PAPER.legal};
  --kraft: ${PAPER.kraft};
  --sticky: ${PAPER.sticky};
  --aged: ${PAPER.aged};
  --ink: ${PAPER.ink};
  --ink-2: ${PAPER.ink2};
  --pencil: ${PAPER.pencil};
  --hair: ${PAPER.hair};
  --red: ${PAPER.red};
  --kai: ${FONT_KAI};
  --code: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --grain: ${GRAIN};
`;

/**
 * 阴影三档 —— 层次全靠它，且只有一个光向。
 * near 用在"刚被动过、摆在最上面"的那张；far 用在贴得最平的。
 */
export const PAPER_SHADOW = {
  far:  '-1px 1px 2px rgba(93,74,44,0.14), -1px 3px 5px rgba(93,74,44,0.09)',
  mid:  '-1px 2px 3px rgba(93,74,44,0.15), -3px 6px 12px rgba(93,74,44,0.15)',
  near: '-2px 3px 4px rgba(93,74,44,0.18), -6px 13px 26px rgba(93,74,44,0.22)',
};

/**
 * 卡片 = 纸。给写 inline style 的组件用：
 *   <div style={{ ...paperCard(), padding: 16 }}>
 *
 * 为什么不是「白底 + 1px 描边 + 圆角」：描边是把卡片**画**出来，影子是把卡片
 * **垫**起来。整套语言里所有实体都是纸，纸靠影子跟底面分开，不靠一条线。
 * lift 选 far / mid / near 三档，对应贴得多平（见 PAPER_SHADOW）。
 */
export function paperCard(lift = 'mid') {
  return {
    background: PAPER.paper,
    backgroundImage: GRAIN,
    border: 'none',
    borderRadius: 2,
    boxShadow: PAPER_SHADOW[lift] || PAPER_SHADOW.mid,
  };
}

/**
 * 墨面 —— 浮在纸上的**工具**表面（2026-08-07）。
 *
 * 整套语言里内容是纸，所以工具不能也是纸：一条跟产物同色的工具条会读成
 * "画布上又多了一张卡"。工具用墨的反相，深色是刻意的 —— 跟画布上那几张
 * 深色工具卡同源，也跟用户给的浮动工具栏参考图一致。
 *
 * ⚠️ 全部走 token，不要在组件里写 `rgba(255,255,255,…)`。2026-08-03 画布
 * hover 工具条那个白框漏了两周，就是因为硬编码的纯白绕过了整套换肤，
 * 逐像素守门法只看登录页也扫不到它。这里的"白"一律是**纸白**（暖的）。
 */
export const INK_SURFACE = {
  /** 面：墨加透，底下的纸透一点出来才像浮着 */
  bg: 'rgba(43,33,23,0.92)',
  /** 分组之间的细线 / 外沿高光 */
  hair: 'rgba(255,254,246,0.16)',
  /** 面上的字与图标 */
  text: PAPER.wall,
  /** 次要态（不可用 / 说明字） */
  textDim: 'rgba(240,234,219,0.55)',
  /** hover 底 */
  hover: 'rgba(255,254,246,0.10)',
  /** 当前工具：暖棕，跟 agent 正在动的那圈同色（CANVAS.brass） */
  active: '#B08C4F',
  /** 当前工具上的字（压在 active 底上） */
  activeText: '#241B12',
  shadow: '0 2px 6px rgba(24,18,12,0.28), 0 10px 28px rgba(24,18,12,0.30)',
};
