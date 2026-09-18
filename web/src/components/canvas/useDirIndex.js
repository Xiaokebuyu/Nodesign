/**
 * useDirIndex —— 目录索引、文件夹卡描述、文件夹窗清单（2026-09-18 从 BoardCanvas 原样抽出）
 *
 * 抽出来是行数棘轮逼的（BoardCanvas 冻在 2113、余量为零），也因为收纳这一批（生成图文件夹、
 * 同类收卡、归堆）三处都要改「这一层装了什么」。判据本体一字未改，只加了两条：
 *   - 旧板留在桌面上的生成图（desk 标记，lib/generated-folder.js）归根层
 *   - 生成图文件夹的名字叫「生成图」，不叫 generated
 */
import { useCallback, useMemo } from 'react';
import { FOLDER_CARD } from '../../lib/board-geometry.js';
import { GENERATED_DIR, GENERATED_TITLE, isDeskPinned } from '../../lib/generated-folder.js';
import { latestFirst, sameKindOf } from '../../lib/folder-stacks.js';

/**
 * @param {object} p
 * @param {Array}  p.objects     派生好的物件
 * @param {object} p.zonesEff    有效文件夹表
 * @param {object} p.layout      物件坐标表
 * @param {Map}    p.taskTitles  服务端给的形态标题
 */
export function useDirIndex({ objects, zonesEff, layout, taskTitles }) {
  /**
   * 目录索引：哪一层装了哪些文件夹、哪些物件。
   *
   * **桌面和文件夹窗共用这一份**（2026-08-13）。两个地方各写一套"这一层装了
   * 什么"的判据，迟早对不上 —— 而这套判据一点都不平凡：归属要沿着祖先往上找
   * 第一个真文件夹（`notes/` `assets/` 是基础设施目录，不是用户的层），
   * 显式 `zone` 字段还要优先。抄一遍就是抄一个必然漂移的东西。
   */
  const dirIndex = useMemo(() => {
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
    // 显式 zone 只给画布原生物件（没有路径）用；带路径的一律按路径推 —— 09-07
    // 参考图案：入座器写过 zone:''，搬进文件夹后改名只换键，显式优先就把卡钉在根。
    // 服务端 layerOf 同一条规则；两头都不认了，存量脏字段自愈。
    const dirOf = (o) => {
      const stored = layout[o.id];
      if (o.native) return stored?.zone || '';        // 画布原生物件跟着字段走
      if (isDeskPinned(o.id, stored)) return '';       // 旧板桌面上的生成图（09-18 不迁移）
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
      // 挂在最近的真文件夹祖先下（09-18）：生成图文件夹是 assets/generated，直接上级 assets/ 不是用户的层，
      // 按直接上级挂的话这张卡落进一个不存在的层 —— 桌面上看不见。服务端 zoneRects 同一条
      const p = homeOf(zid);
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
      // 卡面先露最近的那几件（09-18 归堆那一批：「卡面显示件数与最近一件的缩略」），子文件夹排后面
      const all = [...latestFirst(files.map(f => ({ ...f, mtime: f.o?.mtime }))), ...subs];
      return { count: all.length, peek: all.slice(0, 4) };
    };
    return { dirOf, byDir, subsOf, peekIn };
  }, [objects, zonesEff, layout]);

  /**
   * 一张文件夹卡的完整描述（名字 + 装了什么）。位置由调用方给：桌面读
   * board.json 的坐标，文件夹窗按网格算。
   */
  const folderCardOf = useCallback((id, pos) => ({
    id,
    kind: 'folder',
    x: pos?.x ?? 0,
    y: pos?.y ?? 0,
    w: FOLDER_CARD.w,
    h: FOLDER_CARD.h,
    /**
     * 名字**从路径读**，不读存档里的 `title`。
     *
     * id 就是路径，路径的最后一段就是名字 —— 再存一份 title 就是第二个真相源，
     * 改名之后它立刻过期（实测：`鉴赏页` 改成 `作品集`，zones 行的 title 还写着
     * 「鉴赏页」）。服务端 tasks 给的标题优先，那是它对形态的命名，不是位置的
     * 复制品。
     */
    title: id === GENERATED_DIR ? GENERATED_TITLE : (taskTitles.get(id) || id.split('/').pop() || '文件夹'),
    // 同类收卡（09-18）：里面只有同一类产物时，卡面是其中一件、标题栏给下拉（生成图文件夹不收）
    same: id === GENERATED_DIR ? null : sameKindOf(dirIndex.byDir.get(id) || [], (dirIndex.subsOf.get(id) || []).length),
    ...dirIndex.peekIn(id),
  }), [dirIndex, taskTitles]);

  /** 文件夹窗要的那一层清单（文件夹 + 物件，位置由窗自己排） */
  const listDir = useCallback((dir) => ({
    folders: (dirIndex.subsOf.get(dir) || []).sort().map(id => folderCardOf(id, null)),
    items: [...(dirIndex.byDir.get(dir) || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  }), [dirIndex, folderCardOf]);

  return { dirIndex, folderCardOf, listDir };
}
