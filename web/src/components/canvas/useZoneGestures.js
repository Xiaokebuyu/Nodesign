/**
 * 文件夹卡的手势与删除（2026-08-17 从 BoardCanvas 拆出 —— 行数棘轮）。
 *
 * 一张文件夹卡上要同时接住三件事：拖着挪、单击、双击进去。三者共用一次
 * pointerdown，判据缠在一起，所以它们必须住在同一个地方。
 *
 * ⚠️ 双击**不能用 `onDoubleClick`**：pointerdown 时 setPointerCapture（拖拽
 * 需要），而捕获会让浏览器不再派发 click / dblclick。所以双击是自己数的。
 * BoardCanvas 2026-07-27 就栽过同一个坑（当时是产物卡双击失灵）。
 */
import { useCallback, useRef, useState } from 'react';
import { FOLDER_CARD } from '../../lib/board-geometry.js';
import { Assets } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * @param {object} p
 * @param {string} p.projectId
 * @param {object} p.camApiRef / p.toolRef / p.openFolderRef / p.winDirRef
 * @param {object} p.removedZonesRef / p.recentDragMovedRef / p.dirtyRef
 * @param {Function} p.setZones / p.setWinDir / p.scheduleSave / p.reload / p.noteUserTakeover
 */
export function useZoneGestures({
  projectId,
  camApiRef, toolRef, openFolderRef, winDirRef,
  removedZonesRef, recentDragMovedRef, dirtyRef,
  setZones, setWinDir, scheduleSave, reload, noteUserTakeover,
}) {
  /**
   * 文件夹卡的手势 —— 2026-08-13 重做：
   *
   *   拖动（>4px）   直接搬走，跟产物卡同一手感
   *   单击           无语义
   *   双击           进这个文件夹
   *
   * 280ms 长按门撤了。它当年防的是"最大命中面积被随手误拖"，但门本身零反馈：
   * 按下就拖的前 280ms 所有位移被吞、光标还是 pointer，松手又因为 moved 被
   * 判"什么都不做" —— 体感就是这卡**既拖不动也点不开**（用户报）。误触之忧
   * 由 4px 阈值 + 单击无副作用兜底，跟产物卡同一套判据。
   *
   * ⚠️ 双击**不能用 `onDoubleClick`**：这里在 pointerdown 时 setPointerCapture
   * （拖拽需要），而捕获会让浏览器不再派发 click / dblclick —— 这个文件
   * 2026-07-27 就栽过同一个坑（当时是卡片双击失灵）。所以双击是自己数的：
   * 第二下 pointerup 时上一次的单击定时器还在，就判定为双击。
   */
  const ZONE_DBLCLICK_MS = 260;
  const zoneDragRef = useRef(null);
  const zoneClickTimer = useRef(null);
  const [draggingZone, setDraggingZone] = useState(null);

  /**
   * @param z 区
   * @param opts.onTap  单击做什么（默认无事）
   * @param opts.onOpen 双击做什么（默认进这个文件夹；传 null 表示没有双击语义）
   */
  const zoneGestureProps = useCallback((z, opts = {}) => ({
    onPointerDown: (e) => {
      if (e.button !== 0 || e.target.closest?.('[data-zone-action]')) return;
      if (camApiRef.current?.isHandMode?.()) return;   // 按着空格 = 挪镜头（同 onObjectPointerDown）
      if (toolRef.current !== 'select') return;        // 工具在手归工具（可以在文件夹卡上画/写）
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      noteUserTakeover();   // 拖动期间 agent 跟随别抢镜头（产物卡同款，原来漏了）
      zoneDragRef.current = {
        id: z.id, startX: e.clientX, startY: e.clientY,
        // 抓点世界坐标 —— 跟物件拖拽同一套换算，相机中途动了也跟手
        grabWorld: camApiRef.current.toWorld(e.clientX, e.clientY),
        origX: z.x, origY: z.y, moved: false,
      };
    },
    onPointerMove: (e) => {
      const d = zoneDragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) <= 4) return;
      if (!d.moved) { d.moved = true; setDraggingZone(d.id); }
      e.stopPropagation();
      const w = camApiRef.current.toWorld(e.clientX, e.clientY);
      const nx = d.origX + (w.x - d.grabWorld.x);
      const ny = d.origY + (w.y - d.grabWorld.y);
      // upsert 而不是"有才改"：agent 刚 mkdir 出来的影子文件夹（ghostZones）
      // 还没进 zones，旧写法 `prev[d.id] ? ... : prev` 对它是静默 no-op ——
      // 卡画得出来但怎么拖都纹丝不动（2026-08-13 查实）。第一次拖动就落户。
      setZones(prev => ({
        ...prev,
        [d.id]: { w: FOLDER_CARD.w, h: FOLDER_CARD.h, ...prev[d.id], x: nx, y: ny },
      }));
    },
    onPointerUp: () => {
      const d = zoneDragRef.current;
      zoneDragRef.current = null;
      if (!d) return;
      if (d.moved) {
        setDraggingZone(null);
        recentDragMovedRef.current = true;      // 别让这一下被当成点击
        dirtyRef.current.zones.add(d.id);
        scheduleSave();
        return;
      }
      const tap = opts.onTap || (() => {});
      // 没有双击语义的时候不用等 —— 那 260ms 是为了给双击让路，白等就是钝
      if (opts.onOpen === null) { clearTimeout(zoneClickTimer.current); tap(); return; }
      // 第二下来了 = 双击
      if (zoneClickTimer.current) {
        clearTimeout(zoneClickTimer.current);
        zoneClickTimer.current = null;
        (opts.onOpen || (() => openFolderRef.current?.(d.id)))();
        return;
      }
      zoneClickTimer.current = setTimeout(() => { zoneClickTimer.current = null; tap(); }, ZONE_DBLCLICK_MS);
    },
    onPointerCancel: () => {
      zoneDragRef.current = null;
      setDraggingZone(null);
    },
  }), [scheduleSave, noteUserTakeover]);


  /**
   * 删文件夹（2026-08-08）。
   *
   * 以前这里是「删任务」，连带把绑定的那次对话一起删 —— 那条绑定随「任务=会话」
   * 一起废了，所以现在只删目录和它在画布上的那些卡，**对话一个字不动**。
   * zid 就是文件夹的工作区相对路径（可以是嵌套的 `稿件/初稿`）。
   */
  /**
   * @param {string} zid
   * @param {string} title
   * @param {{ confirmed?: boolean }} [opts] `confirmed: true` = 调用方已经问过了，别再问。
   *   ⛔ 批量删除必须传它：全局 confirm 是**单槽**的（起新的会把上一个 resolve 成 false），
   *   一个循环里连开三个确认框，前两个会被自己人掐掉，只有最后一个能弹出来 ——
   *   于是「选中三个文件夹删除」只有最后一个真被删。09-08 查实。
   */
  const handleDeleteFolder = useCallback(async (zid, title, opts) => {
    const ok = opts?.confirmed || await useGlobalStore.getState().confirm({
      title: '删除文件夹',
      message: `删除「${title || zid}」？文件夹里的全部内容会一起删掉，此操作不可撤销。对话记录不受影响。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await Assets.removeFolder(projectId, zid);
      // 服务端已把 board.json 里的行清掉，本地 state 也要同步剪，
      // 否则要刷新页面僵尸文件夹才消失（2026-07-30「删不了」修复的一半）
      removedZonesRef.current.add(zid);
      setZones(prev => {
        const next = { ...prev };
        delete next[zid];
        return next;
      });
      // 正开着这个文件夹（或它的子层）的窗 → 关掉，别留一扇指向已删目录的窗
      if (winDirRef.current === zid || winDirRef.current?.startsWith(`${zid}/`)) setWinDir(null);
      reload();
      useGlobalStore.getState().showToast('文件夹已删除', 'info');
    } catch (err) {
      useGlobalStore.getState().showToast(`删除失败：${err.message}`, 'error');
    }
  }, [projectId, reload]);

  return { draggingZone, zoneGestureProps, handleDeleteFolder };
}
