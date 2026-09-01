/**
 * edit-board-place.js —— edit_board 的落位四件（2026-09-01 从 edit-board.js 拆出）
 *
 * 拆的理由是行数棘轮：叠纸给 `obstaclesNear` 加了「按页算」那一档之后 edit-board
 * 顶到 601，规矩是拆不是抬上限。切口跟 `write-on-board-place.js` 同一个形状 ——
 * 一个工厂吃住"这一刻的板"，吐出四个纯粹讲几何的函数。
 *
 * 它们共用的那份"这一刻"是有讲究的：`live` / `liveZones` 是**带上本批已落改动**
 * 的副本，不是磁盘上那份。一批 ops 里第二条要看得见第一条挪到哪儿去了。
 */

import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { UNIT } from '../../../lib/sketch-layout.js';
import { estimateSizeOn, FOLDER_CARD } from '../../../lib/board-kind-sizes.js';
import { currentSheet, overlapIds, resolveSheet } from '../../../lib/board-sheets.js';
import { placeBeside, placeAtOnSheet } from '../../../lib/board-place.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';

export function makeEditPlacer({ board, live, liveZones, known, sessionId, rid, isZone }) {
  const rectOf = (id) => {
    if (isZone(id)) { const z = liveZones[id]; return Number.isFinite(z?.x) ? { x: z.x, y: z.y, ...FOLDER_CARD } : null; }
    const e = live[id]; return e ? { x: e.x, y: e.y, ...estimateSizeOn(board, id, e) } : null;
  };

  /**
   * 压上判定的障碍集（同层，subject/组员除外；含文件夹卡 / 卷卡 / 精灵身位）。
   *
   * sheetId：叠纸之后「压住了谁」要按**看得见的那一页**算（2026-09-01 刀 2）——
   * 一摞纸占同一块地，别页的墨此刻不在屏幕上，报它被压住是句假话。
   */
  const obstaclesNear = (zone, exclude = new Set(), sheetId = null) =>
    obstaclesIn(board, zone, { objects: live, exclude, sheetId: zone ? null : sheetId });

  /** 相对落位 = 精确贴放（2026-08-29：环搜退役 —— 压上如实报，不代找洞） */
  const placeRel = (subjectId, box, rel) => {
    const refId = rid(rel.ref);
    const r = rectOf(refId);
    if (!r) return null;
    const zone = layerOf(refId, live[refId], known);
    const p = placeBeside(r, box, rel.side, rel.gap ?? UNIT);
    const pressed = overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h },
      obstaclesNear(zone, new Set([subjectId]), live[refId]?.sheet || null));
    return { ...p, pressed };
  };

  /** 纸内绝对坐标 → 世界（sheet 缺省当前纸；钳进版心，钳了如实报） */
  const placeAbs = (to, box) => {
    const s = to.sheet && board.sheets?.[to.sheet]
      ? resolveSheet(board, to.sheet)
      : currentSheet(board, currentSheetIdOf(sessionId));
    if (!s) return null;
    const p = placeAtOnSheet(s, { x: to.x, y: to.y }, box);
    return { ...p, sheetId: s.id };
  };

  return { rectOf, obstaclesNear, placeRel, placeAbs };
}
