/**
 * 两种纸 —— 首页上"设计 / 演出"这件事的唯一一份定义（2026-08-28）。
 *
 * 皮全在 home-styles.js 的 .nd-sheet-* 那两条配方里（底色 / 格线 / 页边或版心 /
 * 底下压着什么纸）。这里只放**模式到配方类的映射**，因为它现在有两个读者：
 *   home-quick-entry.jsx —— 输入栏那一叠纸（当前这张是哪种）
 *   Home.jsx            —— 桌上每一张项目卡（这个项目是哪种）
 * 两处各写一份 'nd-sheet-rp' 迟早分叉，而分叉的样子是"卡片和输入框长得不像同一
 * 个世界的纸"，没人会当成 bug 报。
 */

/** 模式 → 配方类。⚠️ 类名改了这儿改一处就够，但 CSS 里那两条得跟着改 */
export const SHEET_CLS = { design: 'nd-sheet-design', rp: 'nd-sheet-rp' };

/** 页签上的字。⚠️ 别在这儿包 t()：模块级 const 只求值一次，会把语言烤死 */
export const MODE_LABEL = { design: '设计', rp: '演出' };

/**
 * 项目的 mode 来自服务端，老项目可能是 null/undefined —— 一律当设计。
 * 不写成 `SHEET_CLS[mode] || …` 的兜底：那种写法出错时是"某张卡没有底色"这种
 * 静默的怪样子，而这里显式收敛成两种之一，最坏也只是归错档、看得见。
 */
export function sheetClassOf(mode) {
  return SHEET_CLS[mode === 'rp' ? 'rp' : 'design'];
}
