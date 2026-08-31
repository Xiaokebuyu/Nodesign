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
 * 两个口都必须码进架带，否则新东西会落回"内容底下另起一行"，压 agent 的纸。
 *
 * 原来这两处各抄了一遍 `x < shelf.x + 360` 的判据（连注释都写着「360/24 对齐
 * 拷贝」）。折列（2026-08-31）加进来之后判据从一条竖带变成一族列，抄三遍必分叉，
 * 所以收成这一份。
 */

export const SHELF_W = 360;
export const SHELF_GAP = 24;
/** 一列码多高就换列 = 一屏（server/lib/screen.js ONE_SCREEN.h = 900 / 0.75） */
export const SHELF_COL_H = 1200;
/** 往哪边加列：远离纸（架立在纸群左侧，所以往左长） */
export const SHELF_COL_STEP = -(SHELF_W + SHELF_GAP);

const COL_LIMIT = 40;

/** 第 col 列的左边界 */
export function shelfColumnX(origin, col) {
  return Math.round(origin.x + col * SHELF_COL_STEP);
}

/**
 * 架上下一个空位：列内往下码，一列码满一屏换下一列。
 * 判据不看 seat —— 谁堵在架上都得让（压上去是数据损坏）。
 * @param {{x:number,y:number}} origin 架原点
 * @param {Array<{x,y,w,h}>} obstacles 同层全部已摆矩形
 * @param {{w?:number,h?:number}} [box] 要放的这一件（给了才折列）
 */
export function nextShelfSpot(origin, obstacles, box = null) {
  const h = Number.isFinite(box?.h) ? box.h : null;
  const rects = (obstacles || []).filter(o => Number.isFinite(o?.x) && Number.isFinite(o?.y));
  let lastX = origin.x; let lastY = origin.y;
  for (let col = 0; col < COL_LIMIT; col += 1) {
    const x = shelfColumnX(origin, col);
    let bottom = origin.y;
    for (const o of rects) {
      if (o.x + (o.w || 0) <= x || o.x >= x + SHELF_W) continue;
      if (o.y + (o.h || 0) <= origin.y) continue;
      bottom = Math.max(bottom, o.y + (o.h || 0) + SHELF_GAP);
    }
    lastX = x; lastY = bottom;
    if (h === null) return { x, y: Math.round(bottom), col };
    if (bottom + h <= origin.y + SHELF_COL_H) return { x, y: Math.round(bottom), col };
    if (bottom === origin.y) return { x, y: Math.round(bottom), col };
  }
  return { x: lastX, y: Math.round(lastY), col: COL_LIMIT - 1 };
}

/** 架原点合法吗（两处调用前都要问一遍） */
export function hasShelf(shelf) {
  return !!shelf && Number.isFinite(shelf.x) && Number.isFinite(shelf.y);
}
