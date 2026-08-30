/**
 * server/lib/board-obstacles.js —— 一层桌面上「谁占着地方」的唯一真相源
 * （2026-08-29 占位契约刀 A）
 *
 * ## 为什么要有这个文件
 *
 * 落位/压上判定原来在三个地方各写了一遍**一模一样**的障碍集合：
 *   write-on-board.js 的 obstaclesOf / edit-board.js 的 obstaclesNear / board-seater.js
 * 三份都只遍历 `board.objects`，于是**不住在 objects 里的东西对落位系统结构性隐形**：
 *
 *   - 文件夹卡（`board.zones`，只存 {x,y}，尺寸是常量 FOLDER_CARD）
 *   - 卷卡（`board.rolls`，前端合成物，矩形由 rollCardRect 现算）
 *
 * 生产 128 块真板实测（根层、剔掉圈注类的合法压盖）：**文件夹被压 112 次**
 * （被产物 34 / 被文件 33 / 被文档 23 / 被板书 13 / 被文件夹 7 / 被文字 2）。
 * 站主点名的「文件夹能被板书覆盖」就是这 13 次，而且它是 100% 必现不是概率问题 ——
 * 工具连"压住了谁"都报不出来，因为那块地在它眼里根本是空的。
 *
 * 收成一份的另一半理由：加一类物件要改三处，改漏一处就是新的隐形物件。
 * 现在加在这儿一次，三个调用点自动同步。
 *
 * ## 边界（写清楚，免得被读成"全量占位"）
 *
 * 这套东西**只约束 agent 的自动落位**，不约束用户的手 —— 用户把卡拖到哪都合法，
 * 拖出纸、拖成重叠都不会被纠正（纸范式纲领：纸是分配纪律不是本体容器）。
 *
 * 不进障碍集合的东西，都是真的不占板面，不是漏了：舞台贴/精灵（浮层，几秒即散，
 * 且精灵自己会避让真卡）、聊天卡/小地图/工具栏（屏幕固定 UI，不在世界坐标系里）、
 * 包络 chip（纯派生的一圈虚线）、连线（是线不是面）。
 */

import { layerOf } from './canvas-id.js';
import { estimateSizeOn, zoneRects } from './board-kind-sizes.js';
import { inflateSpriteSeats, rollCardRect } from './board-sheets.js';

/**
 * 一层的障碍集。
 *
 * @param {object} board    整块板（要读 zones/rolls/hero）
 * @param {string} zone     层名；'' = 根层桌面（文件夹卡和卷卡只在这一层）
 * @param {object} [opts]
 * @param {object} [opts.objects]  用哪份 objects（缺省 board.objects；edit_board
 *   要用带上本批改动的 live 副本，那份才是"这一刻"的板）
 * @param {Set|string[]} [opts.exclude]  排除的 id（主角自己、同组成员）
 * @param {boolean} [opts.furniture=true]  含不含"常驻家具"（文件夹卡/卷卡）。
 *   **落位要（true），铺纸不要（false）**：纸不渲染，一张纸的矩形盖在文件夹上
 *   用户什么也看不见，而纸内落位本来就会避开文件夹；把家具算进铺纸避让，只换来
 *   第一张纸被推离用户视口 —— "在用户眼皮底下开工"当场失效（写这条时刚被自己
 *   的端到端测试逮住：纸从 (0,0) 滑到 y=384 绕开一个文件夹）。
 * @returns {Array<{id,x,y,w,h}>}
 */
export function obstaclesIn(board, zone = '', { objects = null, exclude = null, furniture = true } = {}) {
  const objs = objects || board?.objects || {};
  const known = new Set(Object.keys(board?.zones || {}));
  const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
  const rects = [];
  for (const [id, e] of Object.entries(objs)) {
    if (skip.has(id) || !Number.isFinite(e?.x)) continue;
    if (layerOf(id, e, known) !== zone) continue;
    rects.push({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) });
  }
  // 每层还住着不在 objects 里的占面积物件：文件夹卡按**所在层**取
  //（子文件夹卡住在父层里，2026-08-30 跨层幻影案之前这儿把它们全当根层矩形，
  //  文件夹层内的落位则完全看不见它们 —— 同一个错的两面）；卷卡只在根层。
  if (furniture) {
    for (const z of zoneRects(board, { layer: zone })) {
      if (!skip.has(z.id)) rects.push(z);
    }
  }
  if (!zone && furniture) {
    for (const tag of Object.keys(board?.rolls || {})) {
      if (skip.has(tag)) continue;
      const r = rollCardRect(board, tag);
      // 卷起来的成员座位照旧留在 objects 里当障碍（收纳不等于腾地），这一条
      // 只为让"压住了卷标签"也能被如实报出来。
      if (r) rects.push({ id: `roll:${tag}`, ...r });
    }
  }
  return inflateSpriteSeats(rects, objs);
}
