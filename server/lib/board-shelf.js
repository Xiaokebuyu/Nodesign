/**
 * server/lib/board-shelf.js —— 暂存架（2026-08-30）
 *
 * 机器的手从此只够得到这条架：入座器/步骤镜像找不到 agent 规划的地
 * （for:'artifacts' 版位、chalk 显式锚点）时，一律把东西码在这条竖带上 ——
 * **绝不再铺纸，也绝不再往 agent 的纸面上顺排**。真案 proj_mtfz7n8p：web_search
 * 采回的参考图撞进入座器的「开工例外」，第一张纸成了机器铺的，agent 从头到尾
 * 不知道那张纸存在，自己的板书只能在缝里流。
 *
 * 架上的东西 seat:'shelf'。离架不靠第二份成员表：pin_to_board 写 seat:'agent'、
 * edit_board move 写 seat:'agent'、用户拖拽写 seat:'user' —— 任何一只手一挪，
 * seat 被改写，它就自然不在架上了（单一真相 = 座位出处字段本身）。
 *
 * 架的原点存 board.shelf {x,y}，立了就不挪；唯一的例外是**架带跟后来铺的纸
 * 横向撞上**（agent 有权把纸开在任何地方），这时搬去纸群左侧重立 —— 判据是
 * 整条竖带不是原点那一个点，见 bandHitsSheet。
 */

import { ONE_SCREEN } from './screen.js';
import { layerOf } from './canvas-id.js';
import { isArchivePath } from './task-scan.js';

export const SHELF_W = 360;
export const SHELF_GAP = 24;
/**
 * 一列码多高就换列（2026-08-31）。
 *
 * 架原来是**一根不封口的竖列**：真案 proj_mtg61or1 26 件码到 8322px（板子才高
 * 2600），前端 ShelfHint 按包络画出来是个 228×8346、宽高比 1:41 的虚线框横穿
 * 全部四张纸；proj_mth8wd7k 11 件也拉了 1720px。站主原话「暂存区的内容看起来
 * 可以跨越很多张纸，两个产物之间间隔很大的距离」—— 说的就是这根柱子。
 *
 * 一列 = 一屏高。理由跟 CARD_MAX_H 定成固定值一样：架的形状不该随看它的设备变，
 * 同一块板在手机和大屏上架得是同一个架。
 */
export const SHELF_COL_H = ONE_SCREEN.h;      // 1200
/**
 * 往哪边加列：**远离纸**。架立在纸群左侧（resolveShelfOrigin），所以第 n 列
 * 在原点再往左 n 个列距 —— 越码越远离版面，永远不会横着长进纸里。
 * （架若立在没有纸的板上，往左长也只是往空地长，无害。）
 */
export const SHELF_COL_STEP = -(SHELF_W + SHELF_GAP);
// 文件夹卡在架上的占地（数字对齐 web/src/lib/board-geometry.js 的 FOLDER_CARD ——
// zones 存档只有坐标，尺寸恒为前端那份；这里只用来算架上的避让）
export const FOLDER_BOX = { w: 288, h: 240 };

/**
 * 架带跟这张纸撞不撞。**架不是原点那一个点，是从原点往下的一条竖带**
 * （宽 SHELF_W，向下不封口）。
 *
 * 原来这儿测的是「原点这个点落没落进纸里」，于是架立在纸群**正上方**时
 * 永远判不出冲突，然后顺着这条带一路往下长穿每一张纸。真案 proj_mtg61or1：
 * 架原点 (24,24) 在 p1 上方 1464px，四张纸一张都没"压住"它，但架带 x[24,384)
 * 跟四张纸的横向重叠率是 100% —— agent 写的板书全从 x=24 起排，42 个根层
 * 对象里 38 个压在架带上，架被自己码的货一路顶到 y=8322（板子才高 2600）；
 * 反过来铺新纸又要躲开架上的散件，纸也被顶着往下走（p3 底 3805 → p4 顶 4621）。
 * 两边互相顶，板子只会单向长高。
 */
const bandHitsSheet = (s, x, y) => s.x < x + SHELF_W && s.x + s.w > x && s.y + s.h > y;

/**
 * 架的原点。已立的沿用（除非架带跟纸撞上）；没立过的：有纸靠纸群左上侧，
 * 没纸落在用户视口左上（到货要让用户看得见）。
 * @param {object} board
 * @param {{x,y,w,h}|null} viewport 用户相机（根层才传）
 * @returns {{x:number,y:number,changed:boolean}}
 */
export function resolveShelfOrigin(board, viewport = null) {
  const sheets = Object.values(board.sheets || {})
    .filter(s => Number.isFinite(s?.x) && Number.isFinite(s?.y) && Number.isFinite(s?.w) && Number.isFinite(s?.h));
  const cur = board.shelf;
  if (cur && Number.isFinite(cur.x) && Number.isFinite(cur.y) && !sheets.some(s => bandHitsSheet(s, cur.x, cur.y))) {
    return { x: cur.x, y: cur.y, changed: false };
  }
  if (sheets.length) {
    const minX = Math.min(...sheets.map(s => s.x));
    const minY = Math.min(...sheets.map(s => s.y));
    return { x: Math.round(minX - SHELF_W - SHELF_GAP), y: Math.round(minY), changed: true };
  }
  if (viewport && Number.isFinite(viewport.x) && Number.isFinite(viewport.y)) {
    return { x: Math.round(viewport.x + SHELF_GAP), y: Math.round(viewport.y + SHELF_GAP), changed: true };
  }
  return { x: SHELF_GAP, y: SHELF_GAP, changed: true };
}

/** 第 col 列的左边界（col=0 就是原点那一列） */
export function shelfColumnX(origin, col) {
  return Math.round(origin.x + col * SHELF_COL_STEP);
}

/**
 * 架上下一个空位：**列内从上往下码，一列码满一屏就换下一列**（2026-08-31 折列）。
 *
 * 占位判据是「矩形横向压进这一列的竖带」，不看 seat —— 用户拖了张卡堵在架上，
 * 新到的也得往下让，压上去才是数据损坏。
 *
 * `box.h` 给了就判「这一件放进去会不会超出这一列的屏高」，超了换列；不给就退回
 * 老行为（只找列底）——**唯一会长成柱子的情况**，所以调用方都该把 box 传进来。
 * 兜底：所有列都试遍了（COL_LIMIT）就落在最后一列底部，宁可长也不丢件。
 *
 * @param {{x,y}} origin 架原点（第 0 列左上）
 * @param {Array<{x,y,w,h}>} obstacles 同层全部已摆矩形
 * @param {{w?:number,h?:number}} [box] 要放的这一件（给了才折列）
 */
const COL_LIMIT = 40;
export function nextShelfSpot(origin, obstacles, box = null) {
  const h = Number.isFinite(box?.h) ? box.h : null;
  const rects = (obstacles || []).filter(o => Number.isFinite(o?.x) && Number.isFinite(o?.y));
  let lastX = origin.x; let lastY = origin.y;
  for (let col = 0; col < COL_LIMIT; col += 1) {
    const x = shelfColumnX(origin, col);
    let bottom = origin.y;
    for (const o of rects) {
      if (o.x + (o.w || 0) <= x || o.x >= x + SHELF_W) continue;   // 不压这一列
      if (o.y + (o.h || 0) <= origin.y) continue;                   // 在架顶之上
      bottom = Math.max(bottom, o.y + (o.h || 0) + SHELF_GAP);
    }
    lastX = x; lastY = bottom;
    if (h === null) return { x, y: Math.round(bottom), col };       // 没给尺寸：老行为
    if (bottom + h <= origin.y + SHELF_COL_H) return { x, y: Math.round(bottom), col };
    // 这一列的屏高用完了 —— 但**空列不许因为一件超高的东西被跳过**：一件比一整列
    // 还高的卡放在哪一列都超，那就放在它自己的空列里，别一路把 40 列全跳完。
    if (bottom === origin.y) return { x, y: Math.round(bottom), col };
  }
  return { x: lastX, y: Math.round(lastY), col: COL_LIMIT - 1 };
}

/**
 * 架上现有的东西（画布 id 列表，登记序）。**点名催办的唯一判据** ——
 * 状态块（user-prompt-submit）和 read_board 都问这一份，别再各抄一遍 filter。
 *
 * ⛔ 两条修正（2026-08-31，真案 proj_mth8wd7k 架上 11 件全是幽灵）：
 *
 * ① **层归属要用 `layerOf` 算，不能读 `zone` 字段**。原来写的是 `!e.zone`，而
 *    前端 fresh-seater 落的那种座位**根本不带 zone 字段**（它只写 x/y/seat）。
 *    于是「文件到货时文件夹卡还没出现 → 前端按根层给了它一个架上的座 → 文件夹
 *    随后出现 → 前端 dirOf 改按路径把卡渲染进文件夹里」之后，board.json 里那条
 *    根层架座永远留着：**屏幕上架是空的，状态块每回合报 11 件等安置**。
 *    这是 08-30 那个「结构性隐形」病族的换面复发 —— 判据得跟渲染用的同一套。
 *
 * ② **档案目录不算到货**（`角色/ 世界书/ 预设/ 记忆/`，见 task-scan ARCHIVE_DIRS）。
 *    它们是 agent 要 Read 的档案，不是要摆上版面的产物。
 */
export function shelfItems(board) {
  const known = new Set(Object.keys(board?.zones || {}));
  return Object.entries(board?.objects || {})
    .filter(([id, e]) => e?.seat === 'shelf' && Number.isFinite(e?.x)
      && layerOf(id, e, known) === ''
      && !isArchivePath(String(id)))
    .map(([id]) => id);
}
