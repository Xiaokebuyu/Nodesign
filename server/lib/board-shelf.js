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
 * 架的原点存 board.shelf {x,y}，立了就不挪；唯一的例外是**架位跟后来铺的纸
 * 撞上**（agent 有权把纸开在任何地方），这时搬去纸群左侧重立。
 *
 * ## 2026-09-01：架从一根竖列改成**一摞**
 *
 * 站主拍板「暂存架我们干脆也就改成栈吧」。在这之前架是竖着码的：一列一屏高，
 * 满了往左折一列（08-31 折列刀之前更糟，是一根不封口的柱子，真案 26 件码到
 * 8322px 横穿四张纸）。折列治住了柱子，但架仍然按件数往横里长，而纸现在也横着
 * 排（摞与摞左右相邻）—— 两边迟早还要抢地方。
 *
 * 改成一摞之后架**只占一个位置**：所有货叠在原点上，一次显示最上面那件，上下
 * 翻找。于是跟纸用同一套导航（左右换摞、上下翻页），也再没有"架越长越远"这件事。
 * 退役的一整族：SHELF_COL_H / SHELF_COL_STEP / shelfColumnX / COL_LIMIT / 折列，
 * 连同前端那份 parity 拷贝里的对应部分。
 */

import { ONE_SCREEN } from './screen.js';
import { layerOf } from './canvas-id.js';
import { isArchivePath } from './task-scan.js';

export const SHELF_W = 360;
export const SHELF_GAP = 24;
/**
 * 架位的脚印高度（2026-09-01 一摞）。只用来判「架位撞不撞纸」和画提示框 ——
 * 架上真正的高度是**最高那件**，那由渲染层现算，不存。
 *
 * 取一屏高的三分之一：比大多数卡高（够判撞纸），又不至于把架判成一根柱子。
 */
export const SHELF_H = Math.round(ONE_SCREEN.h / 3);   // 400
// 文件夹卡在架上的占地（数字对齐 web/src/lib/board-geometry.js 的 FOLDER_CARD ——
// zones 存档只有坐标，尺寸恒为前端那份；这里只用来算架上的避让）
export const FOLDER_BOX = { w: 288, h: 240 };

/**
 * 架位跟这张纸撞不撞。
 *
 * ⭐ 判据的形状要跟被判的东西的形状对上（08-30 那一课）。当初这儿测的是「原点
 * 这一个点落没落进纸里」，而架是**从原点往下的一条竖带** —— 架立在纸群正上方时
 * 四张纸一张都"压不住"那个点，判决永远不变，架顺着那条带一路长穿每一张纸
 * （真案 proj_mtg61or1：架带 x[24,384) 跟四张纸横向重叠率 100%，被自己的货顶到
 * y=8322，而板子才高 2600）。
 *
 * 改成一摞之后架就是**一个矩形**（SHELF_W × SHELF_H），判据也跟着回到矩形相交：
 * 形状对上了，就不需要再为它单独想一条规则。
 */
const rectHitsSheet = (s, x, y) => s.x < x + SHELF_W && s.x + s.w > x && s.y < y + SHELF_H && s.y + s.h > y;

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
  if (cur && Number.isFinite(cur.x) && Number.isFinite(cur.y) && !sheets.some(s => rectHitsSheet(s, cur.x, cur.y))) {
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
 * 架上下一件放哪：**就是原点**（2026-09-01 一摞）。
 *
 * 架从此不按件数长 —— 所有货叠在同一个位置，一次显示最上面那件，上下翻找。
 * 所以这儿没有可搜索的东西，`obstacles` 那个入参跟着退役了：以前它是用来在
 * 列里往下让位的，一摞不需要让位（本来就是叠着的）。
 *
 * ⚠️ 架位本身撞不撞纸是 `resolveShelfOrigin` 的事，不在这儿判 —— 一件东西
 * 到货时去挪整个架，会让先到的货和后到的货落在两个地方。
 *
 * @param {{x,y}} origin 架原点
 */
export function nextShelfSpot(origin) {
  return { x: Math.round(origin.x), y: Math.round(origin.y) };
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
