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

import { FONT_KAI } from './theme.js';

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
};

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
