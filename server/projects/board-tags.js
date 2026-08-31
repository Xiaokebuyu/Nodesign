/**
 * server/projects/board-tags.js —— 按标签整组操作板上的东西
 * （2026-08-31 从 board-store 拆出 —— 行数棘轮 661 > 640，按规矩拆不抬上限）
 *
 * 三个动词是一家：它们都**按 tag 找成员、直接改板、绕过 patchBoard 的合并语义**。
 * 绕过是有意的 —— 合并语义（08-25 定，防瘦补丁抹掉 by/seat/w/h）表达不了"删掉某个
 * 键"，所以单字段清除必须走专用路。这份文件就是那条路的家：
 *
 *   commitStaging  清 staging 位（草稿落定）
 *   clearTags      摘 tag
 *   removeByTag    整组删（板书连文件，产物只摘 tag）
 *
 * 再往这儿加动词之前先问一句：它是不是也在"改板上某个键、而 patch 说不清楚"。
 * 是就放这儿，不是就回 board-store 走 patchBoard。
 */

import { withBoardLock, readBoard, writeBoard, chalkAbsPath } from './board-store.js';
import { getSharedDir } from './workspace.js';
import { CHALK_DIR, trashChalkFile } from '../lib/chalk.js';
import { sanitizeTag } from './board-sanitize.js';

/**
 * 草稿落定（2026-08-23 黑板）：把 staging 位清掉，tag 留着当逻辑分组。
 * 不传 tag = 这个项目上所有草稿一起落定（回合结束的兜底用它）。
 * 返回落定了几件，0 = 没草稿，不写盘。
 */
export function commitStaging(pid, { tag = null } = {}) {
  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    let n = 0;
    const hit = (e) => e?.staging === true && (!tag || e.tag === tag);
    for (const o of Object.values(board.objects || {})) if (hit(o)) { delete o.staging; n += 1; }
    for (const b of Object.values(board.bindings || {})) if (hit(b)) { delete b.staging; n += 1; }
    if (n) await writeBoard(pid, board);
    return { board, committed: n };
  });
}

/**
 * 摘掉几件东西的标签（2026-08-31，`edit_board set_tag{tag:""}` 的落盘口）。
 *
 * ⚠️ **不能走 patchBoard**：那儿是合并语义（08-25 定的，防瘦补丁抹掉 by/seat/w/h），
 * 补丁里"没有 tag 这个键"只表示不改它，表达不了"把它删掉"。单字段清除按那条注释
 * 的规矩走专用路 —— 这是继 commitStaging 清 staging、removeByTag 摘 tag 之后的第三条。
 *
 * @returns {Promise<{cleared: number}>}
 */
export function clearTags(pid, ids) {
  const want = new Set((ids || []).filter(x => typeof x === 'string'));
  if (!want.size) return Promise.resolve({ cleared: 0 });
  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    let cleared = 0;
    for (const id of want) {
      const o = board.objects?.[id];
      if (o && o.tag !== undefined) { delete o.tag; cleared += 1; }
    }
    if (cleared) await writeBoard(pid, board);
    return { cleared };
  });
}

/**
 * 按标签整组删除（物件 + 线）。黑板擦 —— 用户或 agent 把一次头脑风暴整块抹掉。
 * 删画布原生物件（text/scribble）和这组的板书文件（notes/板书/，它们是这组自己的话）；
 * 带同一标签的产物卡只摘标签不删座位，产物的本体不归黑板擦管。
 */
export function removeByTag(pid, tag) {
  const t = sanitizeTag(tag);
  if (!t) return Promise.resolve({ board: null, removed: 0 });
  return withBoardLock(pid, async () => {
    const board = await readBoard(pid);
    let removed = 0;
    const gone = new Set();
    for (const [id, o] of Object.entries(board.objects || {})) {
      if (o.tag !== t) continue;
      if (o.kind) { delete board.objects[id]; gone.add(id); removed += 1; continue; }
      // 板书（notes/板书/*.md）是这组自己的话，擦组连文件一起删；其它文件只摘标签。
      // ⛔ 删前按绝对路径断言落在 notes/板书/ 里且是单段文件名（fable 08-23 审出：id 里塞 ../ 能
      // 以进程身份删任意文件；sanitize 现在也拒 `..`，这里是第二道闸）
      if (id.startsWith(`${CHALK_DIR}/`)) {
        const abs = chalkAbsPath(pid, id);
        // 软删进 .nd/trash/（08-25：擦掉的板书要捞得回来）
        if (abs) await trashChalkFile(getSharedDir(pid), abs);
        delete board.objects[id]; gone.add(id); removed += 1; continue;
      }
      delete o.tag;
    }
    for (const [id, b] of Object.entries(board.bindings || {})) {
      if (b.tag === t || gone.has(b.from) || gone.has(b.to)) { delete board.bindings[id]; removed += 1; }
    }
    if (board.hero && gone.has(board.hero)) delete board.hero;
    // 擦组连卷的状态位一起清（收着的组被 erase_group 后不该留一张空卷卡）
    if (board.rolls?.[t]) { delete board.rolls[t]; if (!Object.keys(board.rolls).length) delete board.rolls; }
    await writeBoard(pid, board);
    return { board, removed };
  });
}
