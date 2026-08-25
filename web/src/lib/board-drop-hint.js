/**
 * board-drop-hint —— 拖拽实时落点提示（2026-08-25 从 BoardCanvas 抽出，行数棘轮）
 *
 * 只提示归属，不预告坐标（08-07 的教训：落点由用户的手决定，不由格子决定）。
 * 判据用**被拖那张的中心**落在对方矩形里 —— 矩形相交太灵敏，挨着摆一下就成夹。
 * 板书等 dragMovesFile=false 的：位置自由、归属钉死，不引发搬家（08-24 案）。
 * 多选/整组拖拽不给提示（一批东西掉进文件夹的语义还没定义，别诱导）。
 */
import { sizeOf, dragMovesFile } from './board-kinds.js';

export function computeDropHint({ id, nx, ny, pos, positioned, folderView }) {
  const obj = positioned.find(o => o.id === id);
  if (!obj) return null;
  const sz = sizeOf({ ...obj, pos: pos || obj.pos });
  const cx = nx + sz.w / 2; const cy = ny + sz.h / 2;
  const canMoveFile = dragMovesFile(obj);
  const folder = !canMoveFile ? null : folderView.find(z =>
    cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h);
  const over = (folder || !canMoveFile) ? null : positioned.find(it => {
    if (it.id === id || it.native) return null;
    if (!dragMovesFile(it)) return null;
    const s2 = sizeOf(it);
    return cx >= it.pos.x && cx < it.pos.x + s2.w && cy >= it.pos.y && cy < it.pos.y + s2.h;
  });
  return folder ? { kind: 'folder', id: folder.id } : over ? { kind: 'group', id: over.id } : null;
}
