/**
 * useSeatWriteback —— 把算出来的座位写回 layout（2026-09-01 从 BoardCanvas 拆出）
 *
 * 两种"机器算出来的位置"落盘走同一条路：
 *   `seatFixes`  入座给新到的东西找的落脚点（没坐标的才给，已有坐标的不碰）
 *   `noteFixes`  批注跟着它标注的那件东西走（这个是**覆写** —— 手写字本来就有
 *                坐标，跟随的意义就是换个位置）
 *
 * 拆出来的直接原因是行数棘轮，但它本来就是一件独立的事：算在 board-seating.js，
 * 写在这儿，中间那层 BoardCanvas 只是路过。
 */
import { useEffect } from 'react';

export function useSeatWriteback({ seatFixes, noteFixes, movingRef, setLayout, dirtyRef, scheduleSave }) {
  useEffect(() => {
    const ids = Object.keys(seatFixes || {});
    const nIds = Object.keys(noteFixes || {});
    if (!ids.length && !nIds.length) return;
    /**
     * ⚠️ 有东西正在改身份（搬家 / 改名）时**一律不落位**。
     *
     * 改名是前缀改名：`鉴赏页` → `作品集` 之后，里面每一件的 id 都变了。产物
     * 清单和文件夹清单不是同一拍回来的，中间那一拍里 `作品集` 还不在文件夹
     * 清单里，于是归属规则往上走一直走到根 —— 里面的东西短暂地"出现在桌面上"，
     * 这一趟就给它们排座并写盘。等清单追上，它们回到文件夹里，却带着一组
     * 在根上算出来的坐标。
     *
     * 落位是"给新东西一个落脚点"，不是"给正在改名的东西重新安家"。等这一拍过去。
     */
    if (movingRef.current.size) return;
    setLayout((prev) => {
      let touched = false;
      const next = { ...prev };
      for (const id of ids) {
        if (prev[id] && Number.isFinite(prev[id].x)) continue;   // 已经有坐标了
        // seat 默认 'auto'（出处四值 auto/user/agent/shelf，user 的永不被重排）；
        // 架上落的座 fix 自带 seat:'shelf'
        next[id] = { ...(prev[id] || {}), seat: 'auto', ...seatFixes[id], z: prev[id]?.z ?? 1 };
        dirtyRef.current.objects.add(id);
        touched = true;
      }
      // 只动还存在的（字可能刚被删）
      for (const id of nIds) {
        if (!prev[id]) continue;
        if (prev[id].x === noteFixes[id].x && prev[id].y === noteFixes[id].y) continue;
        next[id] = { ...prev[id], ...noteFixes[id] };
        dirtyRef.current.objects.add(id);
        touched = true;
      }
      if (touched) scheduleSave();
      return touched ? next : prev;
    });
  }, [seatFixes, noteFixes, movingRef, setLayout, dirtyRef, scheduleSave]);
}
