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

import { UNIT, shapePath, roughFreePath } from './sketch-layout.js';
import { stencilStrokes, STENCIL_NAMES } from './sketch-stencils.js';
import { expandModifiers } from './sketch-array.js';
import { flattenClosed, hatchD } from './sketch-hatch.js';

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
    // makeOne：按种子重新生成一份本尊 —— 算子展开的每一份各自的抖（看起来是
    // 手画了 n 遍，不是图章盖了 n 下）。返回 {rect, d}，d 局部于 rect。
    let makeOne;
    if (s.kind === 'path') {
      // 单位单义（2026-08-30 画图探针案）：d 的坐标与 at/w/h **同一套格**（1 格 =
      // 24px，小数随意）。此前 schema 写着"d 是像素"而 at 是格 —— 同一个形状两套
      // 单位，真会话里整幅画的 path 墨迹只有别的图元 1/24 大，agent 误诊成
      // 「path 不渲染」，从此只敢用 rect/circle 拼图，曲线全灭。
      if (!s.d || !/^[\dMLQCZ ,.\-eE]+$/.test(s.d)) return { error: `形状 ${sid}：path 只收大写 M/L/Q/C/Z 与数字（绝对坐标，单位=格）` };
      const nums = s.d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
      if (!nums.length) return { error: `形状 ${sid}：path 里没有坐标` };
      const xs = nums.filter((_, k) => k % 2 === 0); const ys = nums.filter((_, k) => k % 2 === 1);
      const P = 6;
      const minX = Math.min(...xs) * UNIT; const minY = Math.min(...ys) * UNIT;
      const w = Math.max(4, (Math.max(...xs) - Math.min(...xs)) * UNIT);
      const h = Math.max(4, (Math.max(...ys) - Math.min(...ys)) * UNIT);
      // ×UNIT 并平移到墨迹包围盒（pad 6）—— rect 跟墨走，选中框不再套住一片空气
      let k = 0;
      const local = s.d.replace(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g, (n) => {
        const v = Number(n) * UNIT - ((k++ % 2 === 0) ? minX : minY) + P;
        return String(Math.round(v * 10) / 10);
      });
      const rect0 = { x: (s.at?.x || 0) * UNIT + minX - P, y: (s.at?.y || 0) * UNIT + minY - P, w: w + P * 2, h: h + P * 2 };
      let fillPolys = null;
      if (s.fill) {
        const fc = flattenClosed(local);
        if (!fc.closedAny) return { error: `形状 ${sid}：fill 只对闭合轮廓生效（Z 收尾）—— 这条 path 没有闭合的子路径` };
        fillPolys = fc.polys;
      }
      makeOne = (sx) => ({ rect: { ...rect0 }, d: roughFreePath(local, seed + sx) + (fillPolys ? ' ' + hatchD(fillPolys, seed + sx) : '') });
    } else if (s.kind === 'stencil') {
      // 词汇表（刀①）：参数化简笔画 —— 名字 + 位置 + 尺寸，一笔一画归机器
      if (!STENCIL_NAMES.includes(s.name)) return { error: `形状 ${sid}：stencil 认识这些名字 —— ${STENCIL_NAMES.join(', ')}` };
      if (!s.at || !s.w) return { error: `形状 ${sid}：stencil 要 at + w（格；h 可省 = 按图形比例）` };
      const st = stencilStrokes(s.name, s.w * UNIT, s.h ? s.h * UNIT : null);
      const flipped = s.flip
        ? st.strokes.map((d) => { let k2 = 0; return d.replace(/-?\d*\.?\d+/g, (n) => ((k2++ % 2 === 0) ? String(Math.round((st.w - Number(n)) * 10) / 10) : n)); })
        : st.strokes;
      const rect0 = { x: s.at.x * UNIT - 6, y: s.at.y * UNIT - 6, w: st.w + 12, h: st.h + 12 };
      let stFill = null;
      if (s.fill) {
        const fc = flattenClosed(flipped.join(' '));
        if (!fc.closedAny) return { error: `形状 ${sid}：这个 stencil 没有闭合轮廓，fill 排不了线` };
        stFill = fc.polys;
      }
      makeOne = (sx) => ({
        rect: { ...rect0 },
        d: flipped.map((d2, j) => roughFreePath(d2, `${seed}${sx}:${j}`)).join(' ')
          + (stFill ? ' ' + hatchD(stFill, seed + sx) : ''),
      });
    } else if (s.kind === 'line' || s.kind === 'arrow' || s.kind === 'underline') {
      if (s.fill) return { error: `形状 ${sid}：${s.kind} 是一笔线，没有内部可填 —— fill 只给闭合形状` };
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
      makeOne = (sx) => {
        const sp = shapePath(s.kind, { to: { x: b.x - a.x, y: b.y - a.y } }, seed + sx);
        return { rect: { x: Math.min(a.x, b.x) - 6, y: Math.min(a.y, b.y) - 6, w: sp.w, h: sp.h }, d: sp.d };
      };
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
      let boxFill = null;
      if (s.fill) {
        const P2 = 6;
        if (s.kind === 'rect') {
          boxFill = [[{ x: P2, y: P2 }, { x: P2 + box.w, y: P2 }, { x: P2 + box.w, y: P2 + box.h }, { x: P2, y: P2 + box.h }]];
        } else {
          const rx = box.w / 2; const ry = (s.kind === 'circle' ? box.w : box.h) / 2;
          const pts = [];
          for (let a2 = 0; a2 < 24; a2 += 1) {
            const t2 = (a2 / 24) * Math.PI * 2;
            pts.push({ x: P2 + rx + Math.cos(t2) * rx, y: P2 + ry + Math.sin(t2) * ry });
          }
          boxFill = [pts];
        }
      }
      makeOne = (sx) => {
        const sp = shapePath(s.kind, { w: box.w, h: box.h }, seed + sx);
        return { rect: { x: box.x - 6, y: box.y - 6, w: sp.w, h: sp.h }, d: sp.d + (boxFill ? ' ' + hatchD(boxFill, seed + sx) : '') };
      };
    }
    // 算子展开（刀④）：repeat/ring/mirror/scatter —— 等距和对称归机器
    const pieces = expandModifiers(s, makeOne, sid);
    if (pieces.error) return { error: pieces.error };
    // 包着节点的记号记 hug：落盘后编辑侧挪节点它跟着走（散架病的另一半在 edit-board）
    const hugKey = (s.around && ['rect', 'ellipse', 'circle', 'underline'].includes(s.kind)) ? s.around : null;
    for (const pc of pieces) {
      if (isTaken(pc.key) || shapes.some((x) => x.key === pc.key)) return { error: `形状 id「${pc.key}」撞名（算子副本叫 <id>-2, <id>-3…，别的形状别占这些名）` };
      shapes.push({ key: pc.key, rect: pc.rect, d: pc.d, color, width, hug: hugKey });
    }
    if (shapes.length > 120) return { error: `形状展开后超过 120 件（第 ${i + 1} 个展开完是 ${shapes.length}）—— 阵列收敛一点，或拆成几张图` };
  }
  return { shapes };
}
