/**
 * board-dir-index.js —— 「哪一层装了什么」（2026-09-01 从 BoardCanvas 拆出）
 *
 * **桌面和文件夹窗共用这一份**（2026-08-13 收的口）。两个地方各写一套"这一层装了
 * 什么"的判据迟早对不上 —— 而这套判据一点都不平凡：归属要沿着祖先往上找第一个
 * 真文件夹（`notes/` `assets/` 是基础设施目录，不是用户的层），显式 `zone` 字段
 * 还要优先。抄一遍就是抄一个必然漂移的东西。
 *
 * 拆出来的直接原因是行数棘轮（册那一批加了版式底稿）。它本来也不该跟相机、拖拽、
 * 落位挤在一个文件里：它是一次纯粹的数据变换，没有交互也没有状态。
 */
import { useMemo } from 'react';

export function useDirIndex({ objects, zonesEff, layout }) {
  return useMemo(() => {
    const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };
    /**
     * 它住在哪一层。
     *
     * ⚠️ **不是直接取上级目录就完事**：`notes/灵感.md`、
     * `assets/generated/星空.webp` 的上级目录压根不是"用户的文件夹"
     * （`notes/` `assets/` 是基础设施目录，服务端的文件夹清单里没有它们）。
     * 直接按上级目录归属的话，这些东西会落在一个**不存在的层**上 ——
     * 看不见，也没有任何入口能进去。
     *
     * 所以往上走，找到第一个真的是文件夹的祖先；一个都没有就归根。
     * 这也顺带覆盖了"文件夹层级超过扫描深度"那种情况。
     */
    const knownFolders = new Set(Object.keys(zonesEff));
    const homeOf = (path) => {
      let d = parentOf(path);
      while (d && !knownFolders.has(d)) d = parentOf(d);
      return d || '';
    };
    // 显式归属字段仍然优先（拖出来的写 ''）—— 它的去留见任务 #13
    const dirOf = (o) => {
      const stored = layout[o.id];
      if (stored && stored.zone !== undefined) return stored.zone || '';
      if (o.native) return stored?.zone || '';        // 画布原生物件跟着字段走
      if (typeof o.id !== 'string') return '';
      const c = o.id.indexOf(':');
      const path = (c > 0 && /^[a-z]+$/.test(o.id.slice(0, c))) ? o.id.slice(c + 1) : o.id;
      return homeOf(path);
    };

    const byDir = new Map();          // 目录 → 这一层的物件
    for (const o of objects) {
      const d = dirOf(o);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(o);
    }
    const subsOf = new Map();         // 目录 → 直接子文件夹
    for (const zid of Object.keys(zonesEff)) {
      const p = parentOf(zid);
      if (!subsOf.has(p)) subsOf.set(p, []);
      subsOf.get(p).push(zid);
    }
    /**
     * 里面装了什么。**只看直接子级**（跟"打开它看到的那一层"一致）。
     *
     * 条目带完整物件引用 `o` —— 文件夹卡面是真缩略（用户要"看一眼知道装了
     * 什么"）。数据当场就有，一个额外请求都不用发；iframe 的账在 FolderFace
     * 里算：视口门 + 缩放门 + 每卡上限。
     */
    const peekIn = (dir) => {
      const subs = (subsOf.get(dir) || [])
        .map(id => ({ kind: 'folder', title: id.split('/').pop(), o: null }));
      const files = (byDir.get(dir) || [])
        .map(o => ({ kind: o.type, title: o.title || o.name || String(o.id).split('/').pop(), o }));
      const all = [...subs, ...files];
      return { count: all.length, peek: all.slice(0, 4) };
    };
    return { dirOf, byDir, subsOf, peekIn };
  }, [objects, zonesEff, layout]);
}
