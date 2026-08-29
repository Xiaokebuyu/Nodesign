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
import { estimateSizeOn } from './board-kind-sizes.js';

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

/** 点落在哪张纸上（重叠时取登记时间最新的 —— 正常分配不产生重叠，这是兜底） */
export function sheetOfPoint(board, pt) {
  let hit = null;
  for (const s of sheetRects(board)) {
    if (!pointIn(pt, s)) continue;
    if (!hit || String(s.at) >= String(hit.at)) hit = s;
  }
  return hit;
}

/** 一张纸的成员（几何派生：物件中心在纸内；staging 也算 —— 草稿也占纸面） */
export function sheetMembers(board, sheetId) {
  const s = board?.sheets?.[sheetId];
  if (!s) return [];
  const out = [];
  for (const [id, e] of Object.entries(board?.objects || {})) {
    if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y)) continue;
    const sz = estimateSizeOn(board, id, e);
    const c = { x: e.x + sz.w / 2, y: e.y + sz.h / 2 };
    if (pointIn(c, s)) out.push({ id, x: e.x, y: e.y, w: sz.w, h: sz.h, entry: e });
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
 * 当前纸：会话指过的那张（还在就认），否则登记时间最新的一张。
 * @param {string|null} preferred  会话层记着的纸名
 */
export function currentSheet(board, preferred = null) {
  const sheets = board?.sheets || {};
  if (preferred && sheets[preferred]) {
    return { id: preferred, ...sheets[preferred] };
  }
  let best = null;
  for (const [id, s] of Object.entries(sheets)) {
    if (!best || String(s.at || '') > String(best.at || '')) best = { id, ...s };
  }
  return best;
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
 * 纪律：纸内按阅读序**接着最低的成员往下排**（左缘=版心左缘），装不下返回 null
 * （调用方翻新纸）。这不是启发式引擎 —— 只有「往下接」一条规则。
 *
 * @returns {{x,y}|null}  世界坐标；null = 这张纸满了
 */
export function nextSpotInSheet(board, sheetId, box, { gap = UNIT } = {}) {
  const s = board?.sheets?.[sheetId];
  if (!s) return null;
  const inner = innerRect(s);
  if (box.w > inner.w) return null;   // 比纸还宽的东西没资格进这张纸
  const members = sheetMembers(board, sheetId);
  const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : inner.y - gap;
  const y = Math.round(bottom + gap);
  if (y + box.h > inner.y + inner.h) return null;
  return { x: Math.round(inner.x), y };
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
    return {
      id: s.id, x: s.x, y: s.y, w: s.w, h: s.h,
      title: s.title, by: s.by, at: s.at,
      count: members.length,
      lastId: members.length ? members[members.length - 1].id : null,
      freeH: Math.max(0, Math.round(inner.y + inner.h - bottom)),
      innerW: inner.w,
    };
  });
}

export { ZOOM_BASIS };
