/**
 * useVisibleObjects —— 这一刻画布上该有哪些物件（2026-09-01 从 BoardCanvas 拆出）
 *
 * 拆的理由是行数棘轮：叠纸给这条链加了「翻页藏页」那一档之后 BoardCanvas 顶到
 * 2136，规矩是拆不是抬上限。拆出来也讲得通 —— 这一整条链回答的是同一个问题
 * （谁在场），跟它下游的入座、命中、渲染是三件事。
 *
 * ## 四道过滤各管一件事，顺序无所谓但语义不同
 *
 *   漏斗    用户此刻想看哪一类（board-filter，两条轴取交集，状态存本地）
 *   档案    根 CLAUDE.md / 记忆/ 那些 agent 的后台档案默认不上画布
 *   收卷    收着的组渲染层不画，卷卡替它站着
 *   翻页    一摞纸里没在显示的那些页上的墨
 *
 * ⭐ 四道全滤在**入座之前**。滤在渲染那一步的话，屏幕上没有而命中区还在，
 * 点空白处会选中一张看不见的卡 —— 座位仍留在 layout 里，服务端落位照旧把它们
 * 当障碍，那是有意的（藏起来不等于那块地空了）。
 */
import { useMemo } from 'react';
import { deriveBoardObjects } from '../../lib/board-objects.js';
import { passesFilter, isArchivePath } from '../../lib/board-filter-axes.js';

export function useVisibleObjects({ tasks, artifacts, layout, browse, filter, showArchive, rolls, paging }) {
  return useMemo(
    () => deriveBoardObjects({ tasks, artifacts, layout, browse })
      .filter((o) => passesFilter(o, filter))
      .filter((o) => showArchive || !isArchivePath(o.id))
      .filter((o) => { const t = o.tag || o.pos?.tag; return !t || !rolls[t]; })
      /**
       * 翻页（叠纸刀 4）：⚠️ 只藏**认领了纸的墨**。散件 / 文件夹卡 / 产物没有
       * sheet 字段，一页都不藏 —— 它们不参与叠放，翻到哪一页都看得见。判据跟
       * 服务端算占位那份是同一条（board-sheets.js 的 claimedBy），两边一致才不会
       * 出现「屏幕上没有、可服务端说那儿占着地方」。
       */
      .filter((o) => !paging.isHidden(layout[o.id])),
    [tasks, artifacts, layout, browse, filter, showArchive, rolls, paging],
  );
}
