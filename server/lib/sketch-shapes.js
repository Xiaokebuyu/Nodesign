/**
 * server/lib/sketch-shapes.js —— sketch 形状构建（2026-08-27 行数棘轮拆件）
 *
 * 从 mcp/tools/write-on-board.js **原样**搬出：入参形状声明 → 局部像素矩形 +
 * 手绘 path + hug 标记。纯计算、不碰磁盘；语义一字未动，搬家原因只有一个 ——
 * write-on-board 顶到 600 行棘轮（642），拆最独立的这一块。
 *
 * 返回 { shapes } 或 { error }（原来的 err() 出口改成 error 字符串，调用方
 * 自己包成工具错误 —— 这层不该知道 MCP 的返回形状）。
 */

import { UNIT, shapePath } from './sketch-layout.js';

/** 板书墨色表（zod 不硬拒，认不出落 ink —— 风格不用 -32602 管） */
export const SKETCH_COLORS = ['ink', 'red', 'pencil', 'brass'];

/**
 * @param {Array} shapesIn  工具入参的 shapes
 * @param {object} deps
 *   rectOfNode(key) → {x,y,w,h}|null   已落位节点的局部矩形
 *   isTaken(id) → boolean              id 是否已被节点/形状占用
 *   tag                                本张图的 tag（手绘抖动的种子）
 * @returns {{shapes: Array<{key,rect,d,color,width,hug}>}|{error: string}}
 */
export function buildSketchShapes(shapesIn, { rectOfNode, isTaken, tag }) {
  const shapes = [];
  for (let i = 0; i < shapesIn.length; i += 1) {
    const s = shapesIn[i];
    const sid = s.id || `s${i + 1}`;
    if (isTaken(sid) || shapes.some(x => x.key === sid)) return { error: `形状 id「${sid}」跟节点/别的形状重名（形状缺省叫 s1,s2…，节点别用这类名）` };
    const seed = `${tag || 'solo'}:${sid}`;
    // 缺省一律 ink。曾有个 'ink2'（箭头用更深墨色）的死分支：色板里没这个色，
    // 落盘前的白名单每次都把它打回 'ink'，意图从未生效 —— 08-28 勘查后铲平。
    const color = SKETCH_COLORS.includes(s.color) ? s.color : 'ink';
    const width = s.width || 2;
    let rect; let d;
    if (s.kind === 'path') {
      if (!s.d || !/^[\dMLQCZ ,.\-eE]+$/.test(s.d)) return { error: `形状 ${sid}：path 只收 M/L/Q/Z 与数字` };
      const nums = s.d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
      const xs = nums.filter((_, k) => k % 2 === 0); const ys = nums.filter((_, k) => k % 2 === 1);
      const w = Math.max(4, Math.max(...xs) - Math.min(0, Math.min(...xs))); const h = Math.max(4, Math.max(...ys) - Math.min(0, Math.min(...ys)));
      rect = { x: (s.at?.x || 0) * UNIT, y: (s.at?.y || 0) * UNIT, w: w + 6, h: h + 6 };
      d = s.d;
    } else if (s.kind === 'line' || s.kind === 'arrow' || s.kind === 'underline') {
      let a; let b;
      if (s.kind === 'underline' && s.around) {
        const r = rectOfNode(s.around); if (!r) return { error: `形状 ${sid}：around 指向不存在的节点 ${s.around}` };
        a = { x: r.x + 2, y: r.y + r.h - 2 }; b = { x: r.x + r.w - 2, y: r.y + r.h - 2 };
      } else {
        if (!s.at) return { error: `形状 ${sid}：${s.kind} 要 at 起点` };
        a = { x: s.at.x * UNIT, y: s.at.y * UNIT };
        if (s.toNode) {
          const r = rectOfNode(s.toNode); if (!r) return { error: `形状 ${sid}：toNode 指向不存在的节点 ${s.toNode}` };
          b = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        } else if (s.to) b = { x: s.to.x * UNIT, y: s.to.y * UNIT };
        else if (s.kind === 'underline') b = { x: a.x + (s.w || 4) * UNIT, y: a.y };
        else return { error: `形状 ${sid}：${s.kind} 要 to 或 toNode` };
      }
      const sp = shapePath(s.kind, { to: { x: b.x - a.x, y: b.y - a.y } }, seed);
      rect = { x: Math.min(a.x, b.x) - 6, y: Math.min(a.y, b.y) - 6, w: sp.w, h: sp.h };
      d = sp.d;
    } else {
      let box;
      if (s.around) {
        const r = rectOfNode(s.around); if (!r) return { error: `形状 ${sid}：around 指向不存在的节点 ${s.around}` };
        const pad = s.kind === 'rect' ? 8 : 14;
        box = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
        if (s.kind === 'circle') { const dmax = Math.max(box.w, box.h); box = { x: box.x + (box.w - dmax) / 2, y: box.y + (box.h - dmax) / 2, w: dmax, h: dmax }; }
      } else {
        if (!s.at || !s.w) return { error: `形状 ${sid}：${s.kind} 要 at + w（+h）或 around` };
        box = { x: s.at.x * UNIT, y: s.at.y * UNIT, w: s.w * UNIT, h: (s.h || s.w) * UNIT };
      }
      const sp = shapePath(s.kind, { w: box.w, h: box.h }, seed);
      rect = { x: box.x - 6, y: box.y - 6, w: sp.w, h: sp.h };
      d = sp.d;
    }
    // 包着节点的记号记 hug：落盘后编辑侧挪节点它跟着走（散架病的另一半在 edit-board）
    const hugKey = (s.around && s.kind !== 'line' && s.kind !== 'arrow' && s.kind !== 'path') ? s.around : null;
    shapes.push({ key: sid, rect, d, color, width, hug: hugKey });
  }
  return { shapes };
}
