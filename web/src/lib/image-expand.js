/**
 * 照片「展开模式」（2026-09-12 站主定）：缩略图只露 4:3 的一角，展开 = 按原图比例、
 * 宽 EXPANDED_IMAGE_W 整张铺在画布上。尺寸落盘并盖 sized:'user'（board-kinds.sizeOf 认它，
 * 脚印跟着变：服务端避让 / read_board 自动认）；收回 = 回形态表默认、清章。
 * 比例来源：卡里那张 <img> 的 naturalWidth/Height（缩略图和原图同比例）。
 */
import { KINDS, isExpandedImage } from './board-kinds.js';

export const EXPANDED_IMAGE_W = 480;
/** 图片卡底下那行文件名的高（BoardObject 图片面） */
export const IMAGE_NAME_BAR_H = 26;

/** 给 patchLayout 的布局补丁；naturalOf 可注入（测试 / 没有 DOM 时） */
export function imageExpandPatch(obj, naturalOf = domNaturalOf) {
  if (isExpandedImage(obj)) return { w: KINDS.image.size.w, h: KINDS.image.size.h, sized: null };
  const { nw, nh } = naturalOf(obj);
  const w = EXPANDED_IMAGE_W;
  return { w, h: Math.round(w * nh / nw) + IMAGE_NAME_BAR_H, sized: 'user' };
}

function domNaturalOf(obj) {
  if (typeof document === 'undefined') return { nw: 4, nh: 3 };
  const img = document.querySelector(`[data-board-object="${CSS.escape(String(obj.id))}"] img[data-image-face]`);
  return { nw: img?.naturalWidth || 4, nh: img?.naturalHeight || 3 };
}
