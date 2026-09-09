/**
 * useChalkFoldGate —— 板书中段折叠（ChalkFold）跟高度回写（useMeasuredSize）之间的闸（09-09）。
 *
 * 两条规矩：
 *   1. 展开是临时的、不进占位：展开期间不回写高度，否则天花板等于白装。闸必须是 ref 不能只靠 state ——
 *      ResizeObserver 的回调在被动 effect 清理之前就带着旧闭包跑了（真渲实测：点开那一拍 2123 已落盘）。
 *   2. 板书回写的高度永远不超过天花板：正文晚到（markdown / 字体）那一拍量到的是还没折的真高，而服务端写入时
 *      就把 h 封在 CARD_MAX_H —— 回写只许往这个契约里收。用户亲手拉高过的按他拉的高度算。
 */
import { useMemo, useRef } from 'react';
import { CARD_MAX_H } from '../../../lib/board-geometry.js';

export function useChalkFoldGate({ o, measured, onMeasured }) {
  const chalkCapH = o?.chalk ? (o.pos?.sized === 'user' && o.pos?.h > CARD_MAX_H ? o.pos.h : CARD_MAX_H) : 0;
  const foldOpenRef = useRef(false);
  const onFoldOpenChange = (open) => { foldOpenRef.current = open; };
  const onMeasuredGated = useMemo(() => (measured && onMeasured ? (id, patch) => {
    if (foldOpenRef.current) return;
    if (chalkCapH && patch?.h > chalkCapH) patch = { ...patch, h: chalkCapH };
    onMeasured(id, patch);
  } : null), [measured, onMeasured, chalkCapH]);
  return { chalkCapH, onFoldOpenChange, onMeasuredGated };
}
