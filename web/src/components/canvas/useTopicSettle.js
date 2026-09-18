import { useCallback } from 'react';
import { sizeOf } from '../../lib/board-kinds.js';
import { settleTopics } from '../../lib/topic-settle.js';

/**
 * useTopicSettle —— 卡量出来长大了，就地让开（2026-09-18，折叠整个去掉之后）
 *
 * 板书不再封顶：字体 / markdown / 图晚到，卡在浏览器里才长到真高。服务端写入时的估高多数准
 * （生产 139 条中位偏差 4%），但也有偏两倍多的，所以真高以这里量的为准：量出来比存的高（或宽），
 * 先照旧回写尺寸，再按话题规则把撞上的话题整组推开（lib/topic-settle.js，服务端同一份算法）。
 * 旧板上那些存成 384 的板书第一次打开时也走这条路自己排开。
 *
 * 只在桌面这一层做（文件夹窗里是算出来的网格，不存坐标，也不回写尺寸）。
 */
export function useTopicSettle({ layoutRef, positionedRef, folderViewRef, bindings, patchLayout, setLayout, dirtyRef, scheduleSave }) {
  return useCallback((id, patch) => {
    const prev = layoutRef.current[id];
    patchLayout(id, patch);
    if (!prev || !Number.isFinite(prev.x)) return;
    const grewH = patch?.h != null && patch.h > (prev.h || 0) + 1;
    const grewW = patch?.w != null && patch.w > (prev.w || 0) + 1;
    if (!grewH && !grewW) return;
    // 用户蓝字标注跟着它标的那件走（topic-settle 的 note）
    const note = new Map();
    for (const b of Object.values(bindings || {})) {
      if (b?.type === 'annotates' && b.by === 'user' && String(b.from).startsWith('text:')) note.set(b.from, b.to);
    }
    const items = [];
    for (const o of positionedRef.current || []) {
      if (!o?.pos || !Number.isFinite(o.pos.x)) continue;
      const sz = sizeOf(o);
      const mine = o.id === id;
      items.push({
        id: o.id, x: o.pos.x, y: o.pos.y,
        w: mine && patch.w != null ? patch.w : sz.w, h: mine && patch.h != null ? patch.h : sz.h,
        ...((o.tag || o.pos.tag) ? { tag: o.tag || o.pos.tag } : {}),
        ...(layoutRef.current[o.id]?.hug ? { hug: layoutRef.current[o.id].hug } : {}),
        ...(note.has(o.id) ? { note: note.get(o.id) } : {}),
      });
    }
    if (!items.some((it) => it.id === id)) return;   // 这张不在桌面这一层
    for (const f of folderViewRef.current || []) items.push({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h, folder: true });
    const out = settleTopics(items, [id], { grewFrom: grewH ? { [id]: prev.h || 0 } : null });
    if (!out.moves.length) return;
    setLayout((p) => {
      const n = { ...p };
      for (const m of out.moves) {
        if (!n[m.id]) continue;   // 没座位的不凭空造一条（幽灵座位闸同 patchLayout）
        n[m.id] = { ...n[m.id], x: Math.round(m.x), y: Math.round(m.y) };
        dirtyRef.current.objects.add(m.id);
      }
      return n;
    });
    scheduleSave();
  }, [layoutRef, positionedRef, folderViewRef, bindings, patchLayout, setLayout, dirtyRef, scheduleSave]);
}
