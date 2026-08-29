/**
 * server/lib/board-lanes.js —— 线（lane）的几何与符号地图（2026-08-27 空间规划第一刀）
 *
 * ## 设计总纲：模型声明拓扑，机器做几何
 *
 * 模型对坐标是瞎的（把摆放写成话术必然失效 —— 轮次机同一课），但它对**关系**很强。
 * 所以「线」不是新概念：**线就是 tag** —— chain:true 早就是「接在同 tag 最新一条
 * 下面」（continue 动词现成）。这里补的只有三件真正缺的：
 *
 *   1. **开列** —— 2026-08-29 纸范式后由「铺纸」承担（一条线 = 它自己的一叠纸，
 *      见 board-sheets.js）；这里的 allocateLaneColumn 扫空列已退役。
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

import { UNIT } from './rect.js';

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
