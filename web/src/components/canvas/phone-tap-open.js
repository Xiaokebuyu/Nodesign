/**
 * 手机上「点一下就打开」（2026-09-06）。
 *
 * 手机档单指落在哪儿都归相机（useBoardCamera 的 fingerPansAnywhere），于是卡上的双击永远到不了卡 ——
 * 09-06 之前手机上因此打不开任何产物（08-21 那条规矩的副作用，当时板书还是主要载体，没人需要在手机上开窗）。
 * 现在一次**没有推动画面**的单指点击就是"打开"：产物走桌面双击同一条 primaryOpen，文件夹走 openFolder；
 * 板书除外（它在手机上是空地），动作条 / 区头按钮除外（它们自己有 onClick）。
 *
 * 纯函数，不碰 React：BoardCanvas 那边只剩一行调用（它已经顶在行数棘轮上）。
 * @returns {boolean} 吃掉了这次抬手没有
 */
export function phoneTapOpen(e, { phone, panned, dragged, onChrome, hitAt, positioned, primaryOpen, openFolder, cancel }) {
  if (!phone || e.pointerType !== 'touch' || panned || dragged || onChrome(e)) return false;
  // ⚠️ 手机上单指按下时相机层（data-board-pane）拿着指针捕获，抬手的 e.target 是那层；远脸档的卡还 pointer-events:none。
  // 所以不看 DOM，按几何命中（hitsAt：同 useObjectClick 点选那条）。
  const id = hitAt?.(e.clientX, e.clientY);
  if (id) {
    const o = positioned.find(x => x.id === id);
    if (!o || o.chalk) return false;
    cancel?.(); primaryOpen(o); return true;
  }
  const at = (typeof document !== 'undefined' && document.elementFromPoint?.(e.clientX, e.clientY)) || e.target;
  const zoneEl = at.closest?.('[data-board-zone]');
  if (zoneEl && !zoneEl.closest('[data-zone-action]')) { cancel?.(); openFolder(zoneEl.getAttribute('data-board-zone')); return true; }
  return false;
}
