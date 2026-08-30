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

export const SHELF_W = 360;
export const SHELF_GAP = 24;
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

/**
 * 架上下一个空位：从原点往下码。占位判据是「矩形横向压进架带」，不看 seat ——
 * 用户拖了张卡堵在架上，新到的也得往下让，压上去才是数据损坏。
 * @param {{x,y}} origin
 * @param {Array<{x,y,w,h}>} obstacles 同层全部已摆矩形
 */
export function nextShelfSpot(origin, obstacles) {
  let bottom = origin.y;
  for (const o of obstacles || []) {
    if (!Number.isFinite(o?.x) || !Number.isFinite(o?.y)) continue;
    if (o.x + (o.w || 0) <= origin.x || o.x >= origin.x + SHELF_W) continue;
    if (o.y + (o.h || 0) <= origin.y) continue;
    bottom = Math.max(bottom, o.y + (o.h || 0) + SHELF_GAP);
  }
  return { x: origin.x, y: Math.round(bottom) };
}

/** 架上现有的东西（根层、seat:'shelf' 的画布 id 列表，登记序） */
export function shelfItems(board) {
  return Object.entries(board.objects || {})
    .filter(([, e]) => e?.seat === 'shelf' && !e.zone && Number.isFinite(e.x))
    .map(([id]) => id);
}
