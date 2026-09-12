/**
 * 直播中的板书框占地（2026-09-12）：agent 的 write_on_board 正在流式写、字还没落盘的那块框。
 * 服务端落位原来看不见它（只看 board.objects + 生图幻影），同一轮里紧接着的下一次落位会压上去。
 * 这里把框的矩形随视点上报进 occupied（跟生图幻影同一条路），带 toolUseId 让写板工具剔掉自己那块。
 * 量的是 DOM（[data-stage="chalk-live"] 的真实高），不估。
 */
import { useSyncExternalStore, useMemo, useEffect } from 'react';

let current = [];
const subs = new Set();
export function setLiveChalkOccupied(list) {
  const key = (l) => l.map((r) => `${r.id}:${r.x},${r.y},${r.w},${r.h}`).join(';');
  if (key(list) === key(current)) return;
  current = list;
  subs.forEach((f) => f());
}
export function useLiveChalkOccupied() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current, () => current);
}
export function _resetLiveChalkOccupied() { current = []; }

/** 生图幻影 + 直播板书框，给视点上报用的一份 occupied（内容不变时引用不变） */
export function useOccupiedForServer(phantomOccupied) {
  const live = useLiveChalkOccupied();
  return useMemo(() => (live.length ? [...phantomOccupied, ...live] : phantomOccupied), [phantomOccupied, live]);
}

/** 每次渲染后量一遍直播框的 DOM（[data-stage="chalk-live"]）；内容没变 setLiveChalkOccupied 不会广播 */
export function useLiveChalkMeasure() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const els = [...document.querySelectorAll('[data-stage="chalk-live"][data-block-id]')];
    setLiveChalkOccupied(els.map((el) => ({
      id: el.dataset.blockId, x: Math.round(parseFloat(el.style.left) || 0), y: Math.round(parseFloat(el.style.top) || 0),
      w: Math.round(el.offsetWidth || parseFloat(el.style.width) || 0), h: Math.round(el.offsetHeight || 0),
    })).filter((r) => r.w > 0 && r.h > 0));
  });
}
