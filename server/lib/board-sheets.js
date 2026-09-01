/**
 * server/lib/board-sheets.js —— 纸（sheet）的分配与符号地图（2026-08-29 纸范式刀 1）
 *
 * ## 范式总纲（站主拍板）
 *
 * 落位的旧回路是「模糊锚点 + 机器启发式找洞」，㉚ 五刀证明那一层的坑修不完。
 * 新回路：**开工先铺一张纸（0.75 倍缩放下等于用户一屏的矩形），agent 在纸内用
 * 局部绝对坐标精确摆放，写满翻下一张**。机器只剩两件事：
 *   1. **纸的分配**（下一张纸放哪 —— 缺省当前纸正下方，铺第一张对准用户视口）
 *   2. **局部 → 世界的平移**（纸的原点加上去就完了）
 *
 * 纸是**分配纪律不是本体容器**（08-23 否 frame 的判决不翻案）：成员按几何派生
 * （物件中心落在纸内），组照旧由 tag/线派生。用户的手不受纸约束 —— 拖出纸边界
 * 完全合法。
 *
 * 纸名一律 ASCII（p1/p2/…）：它是模型要写进工具参数的值（中文参数值会让部分
 * 模型静默结束回合 —— feedback-ascii-tool-params）。
 */

import { UNIT, overlaps, bboxOf, pointIn } from './rect.js';
import { ONE_SCREEN, ZOOM_BASIS } from './screen.js';
import { estimateSizeOn, zoneRects } from './board-kind-sizes.js';
import { DEFAULT_CHALK_W } from './sketch-layout.js';
import { ROLE_SLUG_RE } from '../engine/agent/cast.js';
import { layerOf } from './canvas-id.js';
import { CHALK_DIR } from './chalk.js';

/**
 * 根层物件（纸只存在于根层桌面，纸面账目只许数根层的东西）。
 *
 * ⛔ 2026-08-30 跨层幻影案（proj_mtfpehm3 首拍连败 4 发）：文件夹里的文件卡
 * 存的是**文件夹层内坐标**，数值恰好落在根层第一张纸的范围里；这儿原来不分层
 * 直接扫全部 objects，前端根本不渲染的卡在服务端把纸「占满」了 —— 版位报
 * 剩 0 行、整张纸报 full，全是假账。判据只有一条：layerOf 说它在根层才算。
 */
function rootObjects(board) {
  const objs = board?.objects || {};
  const known = new Set(Object.keys(board?.zones || {}));
  const out = [];
  for (const [id, e] of Object.entries(objs)) {
    if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y)) continue;
    if (layerOf(id, e, known) !== '') continue;
    out.push([id, e]);
  }
  return out;
}

/** 纸与纸之间的沟（格子感放在纸与纸之间 —— 登录墙定格动画同一条经验） */
export const SHEET_GAP = 2 * UNIT;   // 48
/** 纸的版心边距：纸内可用区四周留白 */
export const SHEET_MARGIN = UNIT;    // 24

const snap = (v) => Math.round(v / UNIT) * UNIT;

/** 纸尺寸：铺纸那一刻按设备档算（fitFor 的产出直接喂进来），没有就兜底一屏 */
export function sheetSizeFor(fit) {
  if (fit && Number.isFinite(fit.w) && Number.isFinite(fit.h)) {
    return { w: Math.round(fit.w), h: Math.round(fit.h) };
  }
  return { ...ONE_SCREEN };
}

/** 注册表 → 阅读序矩形列表（先上后下、同带先左后右） */
export function sheetRects(board) {
  return Object.entries(board?.sheets || {})
    .map(([id, s]) => ({ id, x: s.x, y: s.y, w: s.w, h: s.h, at: s.at || '', by: s.by || null, title: s.title || null }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** 下一个纸名：p1/p2/…（取最大序号 +1，撕掉的号不复用 —— 名字要能当历史讲） */
export function nextSheetName(board) {
  let max = 0;
  for (const id of Object.keys(board?.sheets || {})) {
    const m = /^p(\d{1,5})$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

/**
 * 点落在哪张纸上。
 *
 * @param {string|null} [own]  这个点上那件东西自己认领的纸（`objects[id].sheet`）。
 *   叠纸之后一个点会同时落在一摞里的每一张纸上（2026-09-01），几何分不出来 ——
 *   它自己说了算。说的那张不在板上或者压根没盖住这个点，才退回几何。
 *   退回时取**登记时间最新**的那张（一摞的顶上那张），跟 latestSheetId 同口径。
 */
export function sheetOfPoint(board, pt, own = null) {
  if (own && board?.sheets?.[own] && pointIn(pt, { id: own, ...board.sheets[own] })) {
    return { id: own, ...board.sheets[own] };
  }
  let hit = null;
  for (const s of sheetRects(board)) {
    if (!pointIn(pt, s)) continue;
    if (!hit || String(s.at) >= String(hit.at)) hit = s;
  }
  return hit;
}

/**
 * 归属判据（2026-09-01 叠纸刀 1）：**几何仍然是闸，`sheet` 字段只在同一块地上
 * 有好几张纸时用来消歧**。
 *
 *   成员 = 中心点落在这张纸的矩形里 且（没有 sheet 字段 或 sheet 字段就是这张纸）
 *
 * 两个性质同时保住，这是选这个形状而不是"显式登记整个取代几何"的全部理由：
 *
 * - **用户的手照旧说了算。** 把卡拖出纸外，几何当场判它不再是成员，不需要谁去
 *   改字段（08-29 纲领：纸约束 agent，不约束人）。改成纯显式登记的话，"拖出去了
 *   但登记还挂在这张纸上"会变成一个吃着版面余量的幽灵。
 * - **叠起来的纸分得开。** 一摞纸共用一块地，几何对它们的答案完全一样；`sheet`
 *   字段就是用来分这一下的。没有它，在第二页写第一笔时第一页的全部内容都会被
 *   算成障碍，第一发就报"纸满"。
 *
 * ⚠️ **没有 sheet 字段的东西算每一页的成员**（用户拖进来的散件、文件夹卡）——
 * 它们不参与叠放、一直画在那儿，所以每一页都得绕开它们。这跟渲染层是同一条
 * 判据：藏起来的只有认领了纸的墨。
 */
export function claimedBy(e, sheetId) {
  const own = e?.sheet;
  return !own || own === sheetId;
}

/**
 * 会参与叠放的那一类 ——「墨」：板书（`notes/板书/*.md` 那种 file-backed 的正文）、
 * 手写字、涂鸦。
 *
 * ⛔ **产物 / 站点卡 / 文档 / 文件夹卡不是墨，它们一页都不认领**（站主拍板：
 * 这一版栈只叠板书）。给产物认领一页就等于把它藏进某一页，而翻到别页时它消失，
 * 那正是「站点产物不应该被覆盖」要防的事。它们照旧只有几何，翻到哪一页都看得见，
 * 于是在占位账上它们是**每一页的成员**（见 claimedBy：没认领的算每一页）。
 *
 * 前端那份判据在 `web/src/components/canvas/useSheetPaging.js` 的 `isInk`：
 * 数据形状不同（那边有 `o.chalk` / `o.native` 标记），分的是同一批东西。
 */
export function isInk(id, entry) {
  if (entry?.kind === 'text' || entry?.kind === 'scribble') return true;
  return typeof id === 'string' && id.startsWith(`${CHALK_DIR}/`);
}

/**
 * 一张纸的成员。文件夹卡（zones）也是成员：它实打实占着那块地，往下接排必须
 * 从它底下起（2026-08-29 占位契约刀 A —— 在这之前它对落位系统整个是隐形的）。
 * staging 也算 —— 草稿也占纸面。
 */
export function sheetMembers(board, sheetId) {
  const s = board?.sheets?.[sheetId];
  if (!s) return [];
  const out = [];
  for (const [id, e] of rootObjects(board)) {
    if (!claimedBy(e, sheetId)) continue;
    const sz = estimateSizeOn(board, id, e);
    const c = { x: e.x + sz.w / 2, y: e.y + sz.h / 2 };
    if (pointIn(c, s)) out.push({ id, x: e.x, y: e.y, w: sz.w, h: sz.h, entry: e });
  }
  // 文件夹卡不认领纸（它不参与叠放），所以每一页都要绕开它
  for (const z of zoneRects(board)) {
    const c = { x: z.x + z.w / 2, y: z.y + z.h / 2 };
    if (pointIn(c, s)) out.push({ id: z.id, x: z.x, y: z.y, w: z.w, h: z.h, entry: null, folder: true });
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** 纸内可用区（世界坐标） */
export function innerRect(s, margin = SHEET_MARGIN) {
  return { x: s.x + margin, y: s.y + margin, w: s.w - margin * 2, h: s.h - margin * 2 };
}

/** 局部坐标（纸内像素，原点=版心左上角）→ 世界坐标 */
export function toWorld(s, local, margin = SHEET_MARGIN) {
  return { x: s.x + margin + local.x, y: s.y + margin + local.y };
}

/** 世界坐标 → 纸内局部坐标 */
export function toLocal(s, world, margin = SHEET_MARGIN) {
  return { x: world.x - s.x - margin, y: world.y - s.y - margin };
}

/**
 * 最新那张纸的名字 = 登记时间（at）最大的那张。**「最新」只有这一份算法**。
 *
 * ⚠️ 2026-08-30：这之前有两份。落位走 currentSheet（按 at），而每回合状态块和
 * read_board 取的是 `sheetRects(board)` 的**最后一项** —— 那个数组按 y 排序，
 * 拿到的是「最下面那张」。平时新纸往下叠、两者恰好重合，`open_sheet{where:
 * 'viewport'}` 把纸铺在上方时就分叉：免费账本会去报一张 agent 根本没在写的纸。
 * 「同一件事各执一词」先想收成一份。
 */
export function latestSheetId(board) {
  let best = null; let bestAt = '';
  for (const [id, s] of Object.entries(board?.sheets || {})) {
    if (!best || String(s.at || '') > bestAt) { best = id; bestAt = String(s.at || ''); }
  }
  return best;
}

/**
 * 这张纸此刻的版式 —— **一摞的版式 + 这一页自己的覆盖**（2026-09-01 册）。
 *
 * ## 为什么版式该长在摞上
 *
 * 08-30 站主否过一次「翻页继承版面」（原话「每张纸规划一次摆放呗？为什么要继承」），
 * ⭐ 但当时否的**不是继承这个想法，是拿继承去补自动翻页那个洞** —— 机器悄悄翻页、
 * agent 不知道自己换了页，继承只是让那个洞不那么难看。那个洞后来是用「纸满不翻页、
 * agent 自己开」堵掉的。
 *
 * 09-01 三件事都变了：agent 每一页都是自己显式开的；页归进了摞，摞是一个有语义的
 * 单位；产物地已经先一步从纸升到了摞（两张叠着的纸各规划一块产物地会互相压）。
 * 版位升上去是同一个动作的另一半。
 *
 * ⭐ 真板实测（77 对相邻页）：**18% 的版位 x/y/w 逐字重复**，另有 **12% 名字一样
 * 但坐标漂了**，漂移量中位数只有 40px 且来回摆（`opts (0,644)→(0,584)→(0,644)`）——
 * 那不是故意换版面，是同一套版面每页重算一遍算不准。这 13 个漂移全出在演出项目上，
 * 正是「一拍一页、版式本该固定」的场合。
 * ⚠️ 第一版统计我拿完整几何比，得出「只有 6% 相同」—— 那个数是假的：翻页裁纸会把
 * 上一张的版位**高度**钳掉，等于在比被裁过的东西。剔掉 h 才是上面这组。
 *
 * 合并语义：按名合并，**纸盖摞**。所以「不声明就沿用，声明了就改这一页」。
 */
export function slotsOf(board, sheet) {
  const s = (typeof sheet === 'string')
    ? (board?.sheets?.[sheet] ? { id: sheet, ...board.sheets[sheet] } : null)
    : sheet;
  if (!s) return {};
  const base = board?.stacks?.[s.stack || s.id]?.slots;
  return base ? { ...base, ...(s.slots || {}) } : (s.slots || {});
}

/**
 * 取一张纸，**版式已经合好**（摞的 + 这一页的）。
 *
 * 收在这一个口是有意的：`slotRectOf` / 报文 / 落位一共十来个读者，让它们各自去
 * 合一遍必然分叉。合并只发生在「把纸取出来」这一刻，取出来之后 `.slots` 就是
 * 这一页真正生效的那一份。
 */
export function resolveSheet(board, id) {
  const e = board?.sheets?.[id];
  if (!e) return null;
  const slots = slotsOf(board, { id, ...e });
  return { id, ...e, ...(Object.keys(slots).length ? { slots } : {}) };
}

/**
 * 当前纸：会话指过的那张（还在就认），否则登记时间最新的一张。版式已合好。
 * @param {string|null} preferred  会话层记着的纸名
 */
export function currentSheet(board, preferred = null) {
  if (preferred && board?.sheets?.[preferred]) return resolveSheet(board, preferred);
  const id = latestSheetId(board);
  return id ? resolveSheet(board, id) : null;
}

/**
 * 给新纸找落点。纪律：
 *   - 铺第一张（或显式要求）对准**用户视口**（agent 在用户眼皮底下开工）
 *   - 续铺缺省落在锚定纸（通常是当前纸）**正下方**（竖着长 = 阅读序，跟章节竖列同构）
 *   - 纸与纸绝不重叠（硬约束，沿轴滑开）；散落的旧物件尽量避开，避不开就压上
 *     （纸画在物件层之下，旧东西看起来就是「摆在这张纸上」—— 如实报，不硬拒）
 *
 * 契约与 resolvePlacement 同款：**没有失败分支**，永远返回一个矩形。
 *
 * @returns {{x,y,w,h, basis:'viewport'|'below-sheet'|'below-content', overlapsLoose:boolean}}
 */
/**
 * 叠一张：新纸跟这一摞现有的纸占同一块地（2026-09-01 叠纸刀 3）。
 *
 * 位置直接抄这一摞的原点 —— 「叠在一起」就是这个意思，这儿没有可搜索的东西。
 * 尺寸仍按此刻的设备档走（人换了机器，新的一页该按新机器铺），所以同一摞里
 * 各页的宽高可以不同；不变量只管 x/y。
 *
 * @returns {{x,y,w,h,basis:'stack',overlapsLoose:false}|null} 摞里一张纸都没有时 null
 */
export function stackSheetRect(board, stackName, size) {
  const members = Object.entries(board?.sheets || {})
    .filter(([id, s]) => (s.stack || id) === stackName && Number.isFinite(s?.x))
    .sort(([, a], [, b]) => String(a.at || '').localeCompare(String(b.at || '')));
  if (!members.length) return null;
  const [, head] = members[0];
  return {
    x: head.x, y: head.y,
    w: Math.max(240, Math.round(size?.w || head.w)),
    h: Math.max(240, Math.round(size?.h || head.h)),
    basis: 'stack', overlapsLoose: false,
  };
}

/**
 * 另起一摞，铺在最右边那一摞的右边（2026-09-01 叠纸刀 3）。
 * 摞是横向排开的 —— 左右换摞、上下翻页，两条轴各管一件事。
 */
export function nextStackRect(board, size) {
  const sheets = sheetRects(board);
  const sz = { w: Math.max(240, Math.round(size?.w || ONE_SCREEN.w)), h: Math.max(240, Math.round(size?.h || ONE_SCREEN.h)) };
  if (!sheets.length) return { x: 0, y: 0, ...sz, basis: 'stack-new', overlapsLoose: false };
  const right = Math.max(...sheets.map((s) => s.x + s.w));
  const top = Math.min(...sheets.map((s) => s.y));
  return { x: snap(right) + SHEET_GAP, y: snap(top), ...sz, basis: 'stack-new', overlapsLoose: false };
}

export function allocateSheetRect({ board, size, viewport = null, nearSheet = null, obstacles = [] }) {
  const sz = { w: Math.max(240, Math.round(size?.w || ONE_SCREEN.w)), h: Math.max(240, Math.round(size?.h || ONE_SCREEN.h)) };
  const sheets = sheetRects(board);
  const anchor = nearSheet ? sheets.find((s) => s.id === nearSheet) || null : null;

  let ideal; let basis;
  if (anchor) {
    ideal = { x: anchor.x, y: anchor.y + anchor.h + SHEET_GAP };
    basis = 'below-sheet';
  } else if (viewport && Number.isFinite(viewport.x)) {
    // 对准视口：纸的左上贴视口左上（snap 到格）。纸比视口大（0.75 基准 vs 用户
    // 此刻缩放）没关系 —— 铺纸之后镜头会去框纸。
    ideal = { x: snap(viewport.x), y: snap(viewport.y) };
    basis = 'viewport';
  } else {
    const content = bboxOf([...sheets, ...obstacles]);
    ideal = content
      ? { x: snap(content.x), y: snap(content.y + content.h) + SHEET_GAP }
      : { x: 0, y: 0 };
    basis = 'below-content';
  }

  const hitsSheet = (r) => sheets.some((s) => overlaps(r, s, SHEET_GAP / 2));
  const hitsLoose = (r) => obstacles.some((o) => overlaps(r, o));

  // 先找「纸不撞纸、也不压散件」的位置；往下滑最多 4 屏，找不到就接受压散件，
  // 只保硬约束（纸不撞纸）。滑动只沿 y 轴 —— 纸的阅读序是竖着长的。
  const MAX_SLIDE = sz.h * 4;
  let clean = null; let sheetClear = null;
  for (let dy = 0; dy <= MAX_SLIDE; dy += UNIT * 2) {
    const r = { x: ideal.x, y: ideal.y + dy, w: sz.w, h: sz.h };
    if (hitsSheet(r)) continue;
    if (sheetClear === null) sheetClear = r;
    if (!hitsLoose(r)) { clean = r; break; }
  }
  if (clean) return { ...clean, basis, overlapsLoose: false };
  if (sheetClear) return { ...sheetClear, basis, overlapsLoose: true };
  // 连纸不撞纸的位置都没有（理想列被纸占满 4 屏）：落到全部纸的最底下
  const all = bboxOf(sheets) || { x: ideal.x, y: ideal.y, w: 0, h: 0 };
  const r = { x: ideal.x, y: snap(all.y + all.h) + SHEET_GAP, w: sz.w, h: sz.h };
  return { ...r, basis, overlapsLoose: hitsLoose(r) };
}

/**
 * 纸内自动落位（给没带坐标的写入用：产物入座、步骤清单、agent 偷懒不给 at）。
 *
 * **跟着设备的形状走**（2026-08-29 站主拍板）：
 *   - 横纸（电脑：2048×973 那种）→ **报纸分栏**：竖着填满一栏，再到右边下一栏顶上，
 *     整页填满才翻页。原来只会往下排一列 —— 一张两个屏幕宽的纸，四分之三是空的。
 *   - 竖纸（手机：屏宽 × 1.6 屏高）→ 只往下。竖屏上分栏等于把每栏挤成一指宽。
 *
 * 栏宽固定 DEFAULT_CHALK_W（不随内容变），否则每写一件栏边界就漂一次，读起来
 * 是锯齿。比一栏宽的东西（产物卡 640）自然占掉它压住的所有栏 —— 算某栏的底部时
 * 认**水平重叠**而不是中心点，宽物件才挡得住它真正盖住的那几栏。
 *
 * 装不下返回 null（调用方翻新纸）。仍然不是启发式引擎：规则只有"竖着填、填满换栏"。
 *
 * @returns {{x,y,col?}|null}  世界坐标；null = 这张纸满了
 */
export function nextSpotInSheet(board, sheetId, box, { gap = UNIT } = {}) {
  const s = board?.sheets?.[sheetId];
  if (!s) return null;
  const inner = innerRect(s);
  if (box.w > inner.w) return null;   // 比纸还宽的东西没资格进这张纸
  const members = sheetMembers(board, sheetId);
  const floor = inner.y + inner.h;

  // 竖纸：只往下（原规则）
  if (inner.w <= inner.h) {
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : inner.y - gap;
    const y = Math.round(bottom + gap);
    if (y + box.h > floor) return null;
    return { x: Math.round(inner.x), y };
  }

  // 横纸：先往下接；这一列到底了，就在纸上往右找第一块放得下的地方。
  // 步长跟这件东西的宽度走，不是切死的栏 —— 机器只是帮忙找地方，版面怎么切
  // 是 agent 自己的事（站主：有限制有规划的自由）。
  const step = Math.max(UNIT * 4, Math.round(box.w) + gap);
  for (let x = inner.x; x + box.w <= inner.x + inner.w + 1; x += step) {
    const hit = members.filter((m) => m.x < x + box.w && m.x + m.w > x);
    const bottom = hit.length ? Math.max(...hit.map((m) => m.y + m.h)) : inner.y - gap;
    const y = Math.round(bottom + gap);
    if (y + box.h <= floor) return { x: Math.round(x), y, moved: x > inner.x };
  }
  return null;   // 纸上哪儿都放不下了 —— 这才叫满
}

/**
 * 这张纸还剩哪些空地（2026-08-29 刀 F，站主要的"有规划的自由"的依据）。
 *
 * agent 要自己判断"还放不放得下、要不要开新一页"，就得知道纸上哪里还空着 ——
 * 只报"最后一件下面还剩多少"是不够的：那一列到底了不等于这张纸满了，右边可能
 * 整片空着。按内容列宽扫一遍，报每一列的剩余高度。
 *
 * @returns {Array<{x:number, freeH:number}>}  x = 纸内局部像素
 */
export function freeColumnsInSheet(board, sheetId, colW = DEFAULT_CHALK_W, gap = UNIT) {
  const s = board?.sheets?.[sheetId];
  if (!s) return [];
  const inner = innerRect(s);
  const members = sheetMembers(board, sheetId);
  const out = [];
  for (let x = inner.x; x + colW <= inner.x + inner.w + 1; x += colW + gap) {
    const hit = members.filter((m) => m.x < x + colW && m.x + m.w > x);
    const bottom = hit.length ? Math.max(...hit.map((m) => m.y + m.h)) : inner.y - gap;
    out.push({ x: Math.round(x - inner.x), freeH: Math.max(0, Math.round(inner.y + inner.h - (bottom + gap))) });
  }
  return out;
}

/* ── 版位（slot，2026-08-29 占位契约刀 E）────────────────────────────────
 *
 * 站主拍板：**agent 应当提前规划所有落位，然后再开始生成**。所以开工那一步不是
 * 「写第一条」而是「把这一屏切成几块地」（open_sheet 的 plan），之后每条内容
 * 点名往哪块地里放。
 *
 * 为什么这比「一条一条自己给 at」强：一张纸是横的（约 2.1:1），一条一条往下写
 * 只会用掉最左边一栏、剩下大半空着；而且写到第五条才发现装不下时，前四条已经
 * 落盘了。先规划＝**版面在内容之前就定死**，装不下当场就知道。
 *
 * 装不下的处理是**拒收**不是挤进去（站主原话：提示 agent 让她分块内容、重新
 * 布置）—— 折叠、裁切、自动缩排都是替它把问题藏起来。
 */

/** 版位矩形（世界坐标）。名字不存在返回 null */
export function slotRectOf(sheet, name, margin = SHEET_MARGIN) {
  const sl = sheet?.slots?.[name];
  if (!sl) return null;
  return {
    x: sheet.x + margin + sl.x, y: sheet.y + margin + sl.y,
    w: sl.w, h: sl.h, about: sl.about || null,
  };
}

/**
 * 落在某块地里的物件（中心点判据，同 sheetMembers；只数根层 —— 版位在纸上，
 * 纸在根层。顶层文件夹卡真占着地也算成员：它就摆在那儿）。
 *
 * @param {string|null} [sheetId] 这块地属于哪张纸。**叠纸之后必须传**（2026-09-01）：
 *   一摞纸共用一块地，不传的话在第二页的版位里算余量会把第一页的内容也数进去，
 *   报出来的"剩几行"是错的，而错的方向是偏少 —— agent 会以为满了去开新纸。
 *   不传等于"这块地不属于任何一张纸"，只对不叠的板成立（存量全是那样）。
 */
export function membersInRect(board, rect, sheetId = null) {
  const out = [];
  for (const [id, e] of rootObjects(board)) {
    if (sheetId && !claimedBy(e, sheetId)) continue;
    const sz = estimateSizeOn(board, id, e);
    const c = { x: e.x + sz.w / 2, y: e.y + sz.h / 2 };
    if (pointIn(c, rect)) out.push({ id, x: e.x, y: e.y, w: sz.w, h: sz.h });
  }
  for (const z of zoneRects(board)) {
    const c = { x: z.x + z.w / 2, y: z.y + z.h / 2 };
    if (pointIn(c, rect)) out.push({ id: z.id, x: z.x, y: z.y, w: z.w, h: z.h, folder: true });
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/**
 * 版位内往下接排。装不下**不返回兜底位置** —— 返回 full + 还剩多少，
 * 调用方据此拒收并把这个数报给 agent。
 *
 * @returns {{x,y}|{full:true, freeH:number, needH:number}}
 */
export function nextSpotInSlot(board, rect, box, { gap = UNIT, sheetId = null } = {}) {
  const members = membersInRect(board, rect, sheetId);
  const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : rect.y - gap;
  const y = Math.round(bottom + gap);
  const freeH = Math.max(0, Math.round(rect.y + rect.h - y));
  /**
   * 宽度也要查（2026-08-31）。这里原来**只查高**，于是把一张 640 宽的产物卡放进
   * 一块 360 宽的版位是"成功"的 —— 卡向右溢出 280px 压到隔壁，工具还报 Placed。
   * 真案 proj_mtgeaeps_7kly：agent 规划了 360 宽的 `for:'artifacts'` 版位专门收
   * v8 的 docx，而 docx 卡恒宽 640。版位装不下就该像装不下高度一样如实拒收。
   */
  if (box.w > rect.w) {
    return { full: true, tooWide: true, freeW: rect.w, needW: box.w, freeH, needH: box.h, taken: members.length };
  }
  if (box.h > freeH) return { full: true, freeH, needH: box.h, taken: members.length };
  return { x: Math.round(rect.x), y };
}

/**
 * 符号地图：板上现在有哪些纸（read_board / 注入 用）。
 * 每张：名字、矩形、件数、剩余高度（版心内从成员最低边到纸底）。
 */
export function sheetSummaries(board) {
  return sheetRects(board).map((s) => {
    const members = sheetMembers(board, s.id);
    const inner = innerRect(s);
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : inner.y;
    // 版式合好的那一份（摞的 + 这一页的）—— 报余量要按真正生效的版位报
    const full = resolveSheet(board, s.id) || {};
    // 版位余量（2026-08-30）：agent 每回合免费拿到的空间账本此前只有整张纸的
    // freeH —— 而它写的时候是往**块**里写。报纸不报块，等于让它对着错的数做判断。
    const slots = Object.entries(full.slots || {}).map(([name, sl]) => {
      const rect = slotRectOf({ ...full, id: s.id }, name);
      const spot = rect ? nextSpotInSlot(board, rect, { w: 1, h: 1 }) : { full: true };
      const freeH = (rect && !spot.full) ? Math.max(0, Math.round(rect.y + rect.h - spot.y)) : 0;
      return { name, about: sl.about || null, freeH, freeLines: Math.max(0, Math.floor((freeH - 8) / 26)) };
    });
    return {
      id: s.id, x: s.x, y: s.y, w: s.w, h: s.h,
      title: s.title, by: s.by, at: s.at,
      count: members.length,
      lastId: members.length ? members[members.length - 1].id : null,
      freeH: Math.max(0, Math.round(inner.y + inner.h - bottom)),
      innerW: inner.w,
      slots,
    };
  });
}

/** 压上了谁（如实报的判据；调用方拿去写返回文案，不据此挪位置） */
export function overlapIds(rect, obstacles, { pad = 0, limit = 6 } = {}) {
  const out = [];
  for (const o of obstacles) {
    if (!overlaps(rect, o, pad)) continue;
    if (o.id) out.push(o.id);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 精灵身位（从 board-place.js 搬来，2026-08-27 建）。角色精灵在客户端贴着该角色
 * 最新一条板书摆，服务端只能把那条当带身位的障碍 —— 四周外扩 pad，新东西的
 * 压上判定就不会压在精灵脸上。「最新」按 objects 插入序。
 */
export function inflateSpriteSeats(obstacles, objects, pad = 60) {
  const last = new Map();
  for (const [id, e] of Object.entries(objects || {})) {
    if (typeof e?.by === 'string' && ROLE_SLUG_RE.test(e.by)) last.set(e.by, id);
  }
  if (!last.size) return obstacles;
  const ids = new Set(last.values());
  return obstacles.map((o) => (ids.has(o.id)
    ? { ...o, x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 }
    : o));
}

/**
 * 卷卡（RollLayer）占位估算（2026-08-29 刀 3）：卷卡是前端合成物不进 objects，
 * 但它真占桌面一角 —— agent 要知道那儿有张卡。位置 = 成员左上角（前端同款），
 * 尺寸按标签字数估（chip：padding + 文字）。成员座位本来就保留当障碍，这只是
 * 让 read_board 能把「那张卷卡」点出来。
 */
export function rollCardRect(board, tag) {
  const roll = board?.rolls?.[tag];
  if (!roll) return null;
  const members = Object.entries(board?.objects || {}).filter(([, e]) => e?.tag === tag && Number.isFinite(e?.x));
  if (!members.length) return null;
  const x = Math.min(...members.map(([, e]) => e.x));
  const y = Math.min(...members.map(([, e]) => e.y));
  const label = String(roll.label || tag);
  const em = [...label].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.62), 0);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(48 + em * 15), h: 40 };
}

export { ZOOM_BASIS };
