/**
 * useBoardMoves —— 画布搬家家族（2026-08-14 可维护性行动 B2，从 BoardCanvas
 * 原样抽出：moveEntry / moveZone / moveManyTo / groupInto + 飞入动画状态）。
 *
 * 服务端只有一个 `/move`（moveEntry 单一实现，agent 的 organize_board 共用），
 * 这里是它的四个前端入口。语义与注释一字未改，抽出只为把 3300 行的怪物
 * 组件切小 —— 谁要改搬家行为，看这一个文件就够。
 */
import { useCallback, useState } from 'react';
import { Assets } from '../../lib/api.js';
import { joinRel } from '../../lib/paths.js';
import { sizeOf } from '../../lib/board-kinds.js';
import { FOLDER_CARD } from '../../lib/board-geometry.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * 搬家顺手改了别处的引用（09-18，服务端 lib/move-follow.js）：说一声。
 * 自动改写用户内容必须看得见 —— 站点里的图路径变了，用户不该是最后一个知道的。
 */
function noteFollow(r) {
  const f = r?.follow;
  if (r?.followError) { useGlobalStore.getState().showToast(`文件搬过去了，但别处的引用没改成：${r.followError}`, 'error'); return; }
  if (!f || !(f.hits || f.anchors)) return;
  useGlobalStore.getState().showToast(`已同步改写 ${f.files} 个文件里的 ${f.hits} 处引用${f.anchors ? `、${f.anchors} 条板书锚点` : ''}`, 'info');
}

export function useBoardMoves({
  projectId, reload, scheduleSave,
  setLayout, setZones, setBindings,
  layoutRef, dirtyRef, movingRef,
  positionedRef, objectsRef, zonesEffRef, folderViewRef,
}) {
  /**
   * 正在飞进文件夹的卡（搬家的告别动画）：旧 id 的座位改指目标文件夹中心、
   * 卡缩小淡出，飞完才撤条目。撤早了旧物件变"无座新客"被自动入座拖去内容区
   * 底部再消失 —— 用户看到的就是那个"扭曲的移入动画"（2026-08-14 查实）。
   */
  const [flyingIds, setFlyingIds] = useState(() => new Set());

  /**
   * 把一个物件真的搬进另一个文件夹。
   *
   * **画布上在哪，磁盘上就在哪** —— 这是用户定的操作系统桌面语义。以前这里只写
   * 一个 `zone` 字段（画布说不属于、磁盘说属于），那种分裂正是「拖进拖出改归属」
   * 这个概念被废掉的原因。
   *
   * id 就是路径，所以搬完之后这张卡换了身份：先把新坐标记在**新 id** 上，再让
   * 服务端搬（它会同步改 board.json 里的物件 / 文件夹 / 归属字段 / 关系线端点），
   * 拿回新 board 后按它对齐本地 state。失败就原样回滚，卡片弹回去。
   *
   * ⚠️ `POST /move` 的 `to` 是**目标目录**，不是目标文件路径
   * （`{ from:'稿件/主稿.html', to:'定稿' }`，`''` = 工作区根）。曾传拼好的新
   * 路径 → 服务端 stat 不到目录 → 404，「拖进任何文件夹都失败而摞两件成夹反倒
   * 能成」就是这么来的。
   */
  const moveEntry = useCallback(async (obj, toFolder, at) => {
    const from = String(obj.id).slice(String(obj.id).indexOf(':') + 1);
    const base = from.split('/').pop();
    const toDir = toFolder || '';
    const to = joinRel(toDir, base);
    if (to === from) return;
    movingRef.current.add(obj.id);
    const nextId = obj.id.includes(':') ? `${obj.id.split(':')[0]}:${to}` : to;

    // 乐观更新：新 id 上先摆好。旧 id **不能直接撤**（撤掉的瞬间旧物件在
    // 清单刷新前变成"无座新客"，自动入座把它拖去内容区底部再消失 —— 扭曲的
    // 移入动画就是这个）。目标文件夹在本层时改成**飞进去**：旧座位改指文件夹
    // 中心、卡缩小淡出（BoardObject 的 vanishing 态），飞完再撤条目。
    const fz = toDir ? folderViewRef.current.find(f => f.id === toDir) : null;
    setLayout(prev => {
      const next = { ...prev };
      next[nextId] = { ...(prev[obj.id] || {}), x: at.x, y: at.y, zone: undefined };
      if (fz) {
        const sz = sizeOf(obj);
        next[obj.id] = {
          ...(prev[obj.id] || {}),
          x: Math.round(fz.x + fz.w / 2 - sz.w / 2),
          y: Math.round(fz.y + fz.h / 2 - sz.h / 2),
        };
      } else {
        delete next[obj.id];   // 目标不在本层（窗里搬 / 搬回根）：没有可飞向的卡，即刻退场
      }
      return next;
    });
    if (fz) {
      setFlyingIds(prev => new Set(prev).add(obj.id));
      setTimeout(() => {
        setLayout(prev => {
          if (!(obj.id in prev)) return prev;
          const next = { ...prev };
          delete next[obj.id];
          return next;
        });
        setFlyingIds(prev => {
          if (!prev.has(obj.id)) return prev;
          const next = new Set(prev);
          next.delete(obj.id);
          return next;
        });
      }, 460);
    }
    try {
      const r = await Assets.moveEntry(projectId, from, toDir);   // ← 目录，不是新路径
      noteFollow(r);
      if (r?.board) {
        // 服务端已经把身份都改好了 —— 以它为准，别让本地的旧条目再写回去
        setZones(r.board.zones || {});
        setBindings(r.board.bindings || {});
        dirtyRef.current = { objects: new Set(), zones: new Set() };
      }
      // 飞行中晚一拍再重拉清单 —— reload 一到旧物件就 unmount，动画会被腰斩
      if (fz) setTimeout(reload, 400); else reload();
    } catch (err) {
      setLayout(prev => {                       // 搬失败：身份没变，把卡放回去
        const next = { ...prev };
        next[obj.id] = { ...(next[nextId] || {}), x: obj.pos.x, y: obj.pos.y };
        delete next[nextId];
        return next;
      });
      setFlyingIds(prev => {                    // 飞到一半失败：现出原形飞回来
        if (!prev.has(obj.id)) return prev;
        const next = new Set(prev);
        next.delete(obj.id);
        return next;
      });
      useGlobalStore.getState().showToast(`搬不过去：${err.message}`, 'error');
    } finally {
      // 产物清单重拉之后旧 id 才会真正消失，这之前一直挡着别给它排座
      setTimeout(() => movingRef.current.delete(obj.id), 4000);
    }
  }, [projectId, reload]);

  /**
   * 把一个**文件夹**搬进另一个文件夹。
   *
   * 服务端是同一个 `/move`（它对目录和文件一视同仁，还自带"不能搬进自己肚子里"
   * 的拦截）。分成两个函数只是因为前端这边身份不一样：文件夹住在 `zones` 里、
   * 没有 `pos`，走不了 moveEntry 那套乐观更新（那套要把坐标记到新 id 上）。
   * 这里干脆不做乐观更新 —— 服务端回来的 board 就是权威，reload 一次到位。
   */
  const moveZone = useCallback(async (zid, toDir) => {
    const from = String(zid);
    const base = from.split('/').pop();
    const to = joinRel(toDir, base);
    if (to === from) return;
    movingRef.current.add(from);
    try {
      const r = await Assets.moveEntry(projectId, from, toDir || '');
      noteFollow(r);
      if (r?.board) {
        setZones(r.board.zones || {});
        setBindings(r.board.bindings || {});
        dirtyRef.current = { objects: new Set(), zones: new Set() };
      }
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`搬不过去：${err.message}`, 'error');
      reload();
    } finally {
      setTimeout(() => movingRef.current.delete(from), 4000);
    }
  }, [projectId, reload, setZones, setBindings]);

  /**
   * 「移动到…」的落点：一组 id（物件或文件夹）搬进同一个目录。
   *
   * **串行**跑：每一次搬家服务端都会重写一遍 board 并返回，并发发出去的话
   * 后一个请求带的是搬家前的画布，回来直接把前一个的结果盖掉。
   */
  const moveManyTo = useCallback(async (ids, toDir) => {
    for (const id of ids) {
      /**
       * ⚠️ 找物件要**两处都找**：`positioned` 只有桌面这一层，而「移动到…」
       * 在文件夹窗里也能点 —— 窗里那些东西住在别的层。只查 positioned 的话，
       * 窗里选了目标什么都不会发生，连个报错都没有（2026-08-13 真跑抓到）。
       */
      const raw = positionedRef.current.find(o => o.id === id)
        || objectsRef.current.find(o => o.id === id);
      if (raw) {
        const pos = layoutRef.current[id] || raw.pos || { x: 0, y: 0 };
        // eslint-disable-next-line no-await-in-loop
        await moveEntry({ ...raw, pos }, toDir, { x: pos.x, y: pos.y });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (zonesEffRef.current[id]) await moveZone(id, toDir);
    }
  }, [moveEntry, moveZone, layoutRef]);

  /** 摞一起自动成夹：把 a 摞到 b 上 → 建新文件夹（落在 b 的位置），两件都搬进去 */
  const groupInto = useCallback(async (a, b) => {
    const bothImages = a.type === 'image' && b.type === 'image';
    try {
      const r = await Assets.createFolder(projectId, {
        parent: '',                       // 摞成夹永远发生在桌面这一层
        // 两张图归一起就叫「图片」，其余给通名 —— 名字是给人看的，不是 id
        name: bothImages ? '图片' : undefined,
      });
      const folder = r?.folder;
      if (!folder) throw new Error('没建成');
      // 文件夹落在被摞的那张的位置上（视觉上"它俩合成了这个"）
      setZones(prev => ({
        ...prev,
        [folder]: { x: Math.round(b.pos.x), y: Math.round(b.pos.y), w: FOLDER_CARD.w, h: FOLDER_CARD.h },
      }));
      dirtyRef.current.zones.add(folder);
      const rel = (o) => String(o.id).slice(String(o.id).indexOf(':') + 1);
      movingRef.current.add(a.id); movingRef.current.add(b.id);
      await Assets.moveEntry(projectId, rel(b), folder);
      await Assets.moveEntry(projectId, rel(a), folder);
      scheduleSave();
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`归不到一起：${err.message}`, 'error');
      reload();
    } finally {
      setTimeout(() => { movingRef.current.delete(a.id); movingRef.current.delete(b.id); }, 4000);
    }
  }, [projectId, reload, scheduleSave]);

  return { flyingIds, moveEntry, moveZone, moveManyTo, groupInto };
}
