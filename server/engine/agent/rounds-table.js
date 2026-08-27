/**
 * engine/agent/rounds-table.js —— rounds 桌（2026-08-27 四模式版式）
 *
 * 轮次模式的版式是四种里唯一拓扑**开工前已知**的：order 声明了列，发言按拍下行。
 * 所以几何从角色手里全部拿走 —— 角色只管写，落位机器排：
 *
 *   - 自己的列已有话 → 续在自己最后一条下面（stack：走 reply_to 线程，线也接上）
 *   - 自己第一次开口 → 列开在 order 里前一个有列的成员**右边**（newColumnRightOf
 *     指他们的列头 = 最早那条；order 靠前的列靠左，桌面从左往右就是发言顺序）
 *   - 我是全场第一个开口的 → null，正常落位（桌从我这儿起）
 *
 * 只在角色**没给任何落位**时生效（reply_to/near/at/open_lane 都没写）——
 * 角色明确想回某句话（比如用户落痕的那条）时，它的手优先。
 *
 * 已知松处（v1 记档）：列按「该角色的全部板书」认，场景之前的旧板书会把列头
 * 拉到老位置 —— RP 板通常就是当前这出戏，先不做场景界。
 */

import { CHALK_DIR } from '../../lib/chalk.js';

/**
 * @param {object|null} scene  sceneSnapshot（mode/order）
 * @param {object} board       readBoard 结果
 * @param {string} by          作者（角色 slug）
 * @returns {{stack: string}|{newColumnRightOf: string}|null}
 */
export function roundsTableHint(scene, board, by) {
  if (!scene || scene.mode !== 'rounds') return null;
  const order = Array.isArray(scene.order) ? scene.order : [];
  const idx = order.indexOf(by);
  if (idx < 0) return null;
  const columnOf = (slug) => Object.entries(board?.objects || {})
    .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x) && (e?.by || '') === slug)
    .map(([id]) => id)
    .sort();   // 板书文件名以时间戳开头，路径序即时间序
  const mine = columnOf(by);
  if (mine.length) return { stack: mine[mine.length - 1] };
  for (let i = idx - 1; i >= 0; i -= 1) {
    const theirs = columnOf(order[i]);
    if (theirs.length) return { newColumnRightOf: theirs[0] };
  }
  return null;
}
