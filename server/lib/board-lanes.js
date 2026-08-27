/**
 * server/lib/board-lanes.js —— 线（lane）的几何与符号地图（2026-08-27 空间规划第一刀）
 *
 * ## 设计总纲：模型声明拓扑，机器做几何
 *
 * 模型对坐标是瞎的（把摆放写成话术必然失效 —— 轮次机同一课），但它对**关系**很强。
 * 所以「线」不是新概念：**线就是 tag** —— chain:true 早就是「接在同 tag 最新一条
 * 下面」（continue 动词现成）。这里补的只有三件真正缺的：
 *
 *   1. **开列**（branch/fresh）：新线的第一条落在哪。从某节点岔出 → 在它旁边找一条
 *      不撞姊妹线的空列；全新话题 → 版图右缘开新列。几何全在这，模型只给一个名字
 *      和一个岔出点。
 *   2. **注册表**：board.lanes = { tag: {x,y,w,parent} }，持久在 board.json 里
 *      （版面地理要跟板走，不跟会话走）。frontier **不存** —— 从成员现算，存了就是
 *      第二份真相源（feedback-single-source-of-truth）。
 *   3. **符号地图**（laneSummaries）：read_board 用它报「有哪些线、各几节、接着写
 *      落哪」—— agent 的空间意识是读得起这张地图，不是看得见像素。
 *
 * 头脑风暴回路因此零空间推理：用户在旧节点标注提问 → agent 回答带
 * open_lane:<那条的id> → 分支列长出来；后续 {tag, chain:true} 续。
 * RP 场景位、跑团拍行是同一注册表的后续消费方（先不建，地基兼容）。
 */

import { UNIT } from './board-place.js';

export const LANE_W = 20 * UNIT;       // 480：一列的占道宽（≈默认板书宽 + 呼吸）
export const LANE_GUTTER = 4 * UNIT;   // 96：列间沟

const PAD = 12;
const overlapsRect = (a, b, pad = 0) => !(
  a.x + a.w + pad <= b.x || b.x + b.w <= a.x - pad
  || a.y + a.h + pad <= b.y || b.y + b.h <= a.y - pad
);

/** 一组矩形的包围盒（空集 null） */
function bboxOf(rects) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + (r.w || 0)); y1 = Math.max(y1, r.y + (r.h || 0));
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * 给新线找一条空列。契约与 resolvePlacement 同款：**没有失败分支** ——
 * 扫不到空列就退到内容底下并标 fallback，绝不返回 null。
 *
 * @param {object} p
 * @param {{x,y,w,h}|null} p.parent  岔出点矩形（null = fresh，从版图右缘开）
 * @param {Array<{x,w}>} p.lanes     已注册线的占道（竖条带：x 区间语义）
 * @param {Array<{x,y,w,h}>} p.obstacles  同层已摆的东西
 * @param {{w,h}} p.box              第一条的尺寸（开窗判据用它的高）
 * @returns {{x,y,w,fallback:boolean}}
 */
export function allocateLaneColumn({ parent = null, lanes = [], obstacles = [], box = null, width = LANE_W }) {
  const content = bboxOf(obstacles);
  const startX = parent
    ? parent.x + parent.w + LANE_GUTTER
    : (content ? content.x + content.w : 0) + LANE_GUTTER;
  const y = parent ? parent.y : (content ? content.y : 0);
  // 开窗：列起点往下这一段必须是空的（第一条 + 一格呼吸），再往下随写随长
  const win = { y, h: (box?.h || 8 * UNIT) + 2 * UNIT };
  for (let x = startX; x <= startX + 80 * UNIT; x += 2 * UNIT) {
    // 姊妹线的占道是**半无限竖条带**：只比 x 区间，不比 y —— v1 宁可铺得开，
    // 不做"上下错开挤同一列"的聪明（那会让两条线的生长迎头相撞）
    if (lanes.some((l) => x < l.x + (l.w || width) && x + width > l.x)) continue;
    if (obstacles.some((o) => overlapsRect({ x, y: win.y, w: width, h: win.h }, o, PAD))) continue;
    return { x, y, w: width, fallback: false };
  }
  // 兜底：内容底下另起一行（跟 bottomSpot 同一精神）
  const bottom = content ? content.y + content.h : 0;
  return { x: content ? content.x : 0, y: Math.round(bottom) + 40, w: width, fallback: true };
}

/**
 * 符号地图：板上现在有哪些线。已注册的报起点/节数/frontier/岔自谁；
 * 没注册但成串的 tag（≥2 件）也报 —— 那是登记制之前长出来的「野线」，
 * chain:true 照样能续，别让 agent 以为它们不存在。
 */
export function laneSummaries(board) {
  const members = new Map();   // tag → [{id, y, bottom}]（有座位的才算）
  for (const [id, e] of Object.entries(board?.objects || {})) {
    if (!e?.tag || !Number.isFinite(e.y)) continue;
    if (!members.has(e.tag)) members.set(e.tag, []);
    members.get(e.tag).push({ id, y: e.y, bottom: e.y + (e.h || 5 * UNIT) });
  }
  const out = [];
  const seen = new Set();
  for (const [tag, l] of Object.entries(board?.lanes || {})) {
    seen.add(tag);
    const ms = (members.get(tag) || []).sort((a, b) => a.y - b.y);
    const last = ms[ms.length - 1] || null;
    out.push({
      tag, registered: true, x: l.x, y: l.y, parent: l.parent || null,
      count: ms.length, lastId: last?.id || null,
      frontier: { x: l.x, y: last ? Math.round(last.bottom) + UNIT : l.y },
    });
  }
  for (const [tag, ms0] of members) {
    if (seen.has(tag) || ms0.length < 2) continue;
    const ms = ms0.sort((a, b) => a.y - b.y);
    out.push({
      tag, registered: false, x: null, y: null, parent: null,
      count: ms.length, lastId: ms[ms.length - 1].id, frontier: null,
    });
  }
  return out;
}
