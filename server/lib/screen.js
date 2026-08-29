/**
 * server/lib/screen.js —— 「一屏」的唯一基准（2026-08-29 纸范式刀 0）
 *
 * 纸范式拍板：一张纸 = **0.75 倍缩放下等于用户一屏**的矩形工作区。
 * 在这之前「一屏」有三个同源近邻值各自散落（fitFor 的 /0.8、board-place 的
 * ONE_SCREEN 1750×1125、sketch-layout 的 SKETCH_FIT 1700×1100），注释里互相
 * 提醒「改缩放基准要几处一起看」—— 现在基准只有这一份，改这里就是改全部。
 *
 * DEFAULT_SCREEN 是没有视点上报时的兜底屏（普通笔记本 1400×900）；真实纸尺寸
 * 永远优先按上报的 device 屏幕算（见 sketch-layout.js fitFor）。
 */

export const ZOOM_BASIS = 0.75;

export const DEFAULT_SCREEN = { w: 1400, h: 900 };

/** 兜底「一屏」世界像素（1400×900 ÷ 0.75 = 1867×1200） */
export const ONE_SCREEN = {
  w: Math.round(DEFAULT_SCREEN.w / ZOOM_BASIS),
  h: Math.round(DEFAULT_SCREEN.h / ZOOM_BASIS),
};
