/**
 * useChalkFoldGate —— 板书高度回写（useMeasuredSize）的天花板（09-09 建，09-17 收窄）。
 *
 * 只剩一条规矩：**回写的高度永远不超过天花板**。正文晚到（markdown / 字体）那一拍量到的是还没折的
 * 真高，而服务端写入时就把 h 封在 CARD_MAX_H，回写只许往这个契约里收；用户亲手拉高过的按他拉的高度算。
 *
 * 09-17 撤掉的那条：原来展开是把卡在原地撑高、再把真高回写，所以要一个 ref 闸挡住「展开期间的回写」
 * （state 晚一拍，ResizeObserver 的回调带着旧闭包先跑 —— 09-09 真渲抓到的竞态）。板书树把展开改成
 * 浮层之后卡高恒等于天花板、永不因展开变化，那条闸和它挡的竞态一起没了。
 */
import { useMemo } from 'react';
import { CARD_MAX_H } from '../../../lib/board-geometry.js';

export function useChalkFoldGate({ o, measured, onMeasured }) {
  const chalkCapH = o?.chalk ? (o.pos?.sized === 'user' && o.pos?.h > CARD_MAX_H ? o.pos.h : CARD_MAX_H) : 0;
  const onMeasuredGated = useMemo(() => (measured && onMeasured ? (id, patch) => {
    if (chalkCapH && patch?.h > chalkCapH) patch = { ...patch, h: chalkCapH };
    onMeasured(id, patch);
  } : null), [measured, onMeasured, chalkCapH]);
  return { chalkCapH, onMeasuredGated };
}
