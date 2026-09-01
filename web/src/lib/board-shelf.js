/**
 * web/src/lib/board-shelf.js —— 暂存架几何（前端那一份，2026-08-31）
 *
 * **这是 `server/lib/board-shelf.js` 的对齐拷贝**，语义必须一字不差 ——
 * `board-shelf.parity.test.js` 直接 import 服务端那份，拿同一批输入逐例比对
 * 落点（比的是行为不是常量：两个常量相等只证明两份拷贝一致，不证明它们对）。
 *
 * 为什么要有前端这一份：机器落位有两个口是服务端够不着的 ——
 *   ① 前端 fresh-seater：服务端入座器有 1.5s 防抖，窗口里前端会抢先给新卡落座
 *   ② 空 `mkdir` 出来的文件夹：没有 file_changed，服务端根本看不见它
 * 两个口都必须码进架位，否则新东西会落回"内容底下另起一行"，压 agent 的纸。
 *
 * ## 2026-09-01：架从一根竖列改成一摞
 *
 * 所有货叠在原点上，一次显示最上面那件，上下翻找 —— 于是这份拷贝里的折列
 * 一族（SHELF_COL_H / SHELF_COL_STEP / shelfColumnX / COL_LIMIT）整个退役，
 * 只剩「架在哪」这一件事。理由见服务端那份的头注。
 */

export const SHELF_W = 360;
export const SHELF_GAP = 24;
/** 架位的脚印高度（判撞纸 + 画提示框用；真高度是最高那件，渲染层现算） */
export const SHELF_H = 400;

/**
 * 架上下一件放哪：**就是原点**（一摞）。没有可搜索的东西，所以也不再收
 * obstacles/box —— 一摞不需要让位，本来就是叠着的。
 * @param {{x:number,y:number}} origin 架原点
 */
export function nextShelfSpot(origin) {
  return { x: Math.round(origin.x), y: Math.round(origin.y) };
}

export function hasShelf(shelf) {
  return !!shelf && Number.isFinite(shelf.x) && Number.isFinite(shelf.y);
}
