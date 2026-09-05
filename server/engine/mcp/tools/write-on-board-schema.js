/**
 * write_on_board 的图形入参 schema（2026-08-28 从 write-on-board.js 拆出 —— 行数棘轮；
 * 纯数据，跟落板逻辑零耦合）。上限是失控兜底不是风格闸：zod 硬拒（-32602 整调用作废）
 * 是最贵的失败模式，可读性走返回值里的软提醒（08-25 用户拍板「移除画板上限」）。
 */

import { z } from 'zod';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { CHALK_DIR } from '../../../lib/chalk.js';
import { STENCIL_NAMES } from '../../../lib/sketch-stencils.js';

const MAX_NODES = 200;
const MAX_SHAPES = 120;
const MAX_EDGES = 400;

const LOCAL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/, 'local id: letters/digits/_/-');
const GRID_PT = z.object({ x: z.number().min(-2000).max(2000), y: z.number().min(-2000).max(2000) });
export const WORLD_PT = z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6) });

export const NODES = z.array(z.object({
  id: LOCAL_ID.describe('Local id to reference from edges/shapes'),
  text: z.string().min(1).max(8000),
  format: z.enum(['plain', 'md']).optional().describe('Default: md when the text carries markdown marks, else plain'),
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
  font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
  at: GRID_PT.optional().describe('Grid position (layout free); top-left of the node'),
  w: z.number().min(3).max(120).optional().describe('Width in grid units (prefer ≤22 = 528px: paragraphs read better growing down than wide)'),
})).max(MAX_NODES);

export const SHAPES = z.array(z.object({
  id: LOCAL_ID.optional(),
  kind: z.enum(['rect', 'ellipse', 'circle', 'line', 'arrow', 'underline', 'path', 'stencil']),
  at: GRID_PT.optional(),
  name: z.enum(STENCIL_NAMES).optional()
    .describe('stencil kind: which pictogram — a hand-tuned little drawing placed at at, scaled to w (h optional, defaults to its natural aspect). Use these instead of drawing common things stroke by stroke'),
  flip: z.boolean().optional().describe('stencil: mirror horizontally (facing the other way)'),
  around: LOCAL_ID.optional().describe('rect/ellipse/circle/underline: wrap this node instead of at/w/h'),
  w: z.number().min(0).max(200).optional(),
  h: z.number().min(0).max(200).optional(),
  to: GRID_PT.optional(),
  toNode: LOCAL_ID.optional(),
  d: z.string().max(8000).optional().describe('path kind: SVG path, UPPERCASE absolute M/L/Q/C/Z only. Coordinates are in the SAME GRID UNITS as at/w/h (1 unit = 24px; decimals fine) — one coordinate space for the whole sketch. Hand-drawn wobble is applied for you; Q/C curves are how you draw anything smooth (a crescent moon, a wave, a sail)'),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
  width: z.number().min(1).max(12).optional(),
  fill: z.enum(['hatch']).optional()
    .describe('Shade the inside with hand-drawn 45° hatching — the line-art way to darken an area (a shadow side, water, a filled banner). Closed shapes only (rect/ellipse/circle, a path whose subpaths end with Z, closable stencils)'),
  // ── 算子（一次挂一个；等距/对称/播撒这类算术归机器，每份笔迹各自抖）──
  repeat: z.object({ n: z.number().int().min(2).max(24), dx: z.number().min(-200).max(200).optional(), dy: z.number().min(-200).max(200).optional() }).optional()
    .describe('LINEAR ARRAY: n copies stepped by (dx,dy) grid units — a fence, windows, steps. Copies are re-inked, not stamped'),
  ring: z.object({ n: z.number().int().min(2).max(24), cx: z.number().min(-2000).max(2000), cy: z.number().min(-2000).max(2000), upright: z.boolean().optional() }).optional()
    .describe('CIRCULAR ARRAY: n copies around grid point (cx,cy). Draw ONE at its 12-o-clock spot. Default ROTATES each copy (petals, clock marks, top-down chairs facing a table); upright:true keeps them unrotated and just seats them round the circle (side-view things with gravity — tents or people round a fire)'),
  mirror: z.object({ axis: z.enum(['x', 'y']), at: z.number().min(-2000).max(2000) }).optional()
    .describe("SYMMETRY: adds a mirrored copy across the axis at grid position `at` (axis:'x' = vertical mirror line). Draw half a butterfly, get the whole one"),
  scatter: z.object({ n: z.number().int().min(2).max(40), in: z.object({ x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1) }) }).optional()
    .describe('SPRINKLE: n copies at seeded-random spots inside the grid rect, with slight size jitter — a starry sky, grass, pebbles. Same call replays identically'),
})).max(MAX_SHAPES);

export const EDGES = z.array(z.object({
  from: z.string().min(1).max(300).describe('local node id or canvas id'),
  to: z.string().min(1).max(300).describe('local node id or canvas id'),
  type: z.enum(BINDING_TYPE_IDS).optional().describe('default link'),
  material: z.enum(BINDING_MATERIALS).optional().describe('default pencil'),
  label: z.string().max(60).optional(),
})).max(MAX_EDGES);

/**
 * ⚠️ 字段顺序有意义：模型按 schema 声明顺序生成 JSON，入参是**流式**到达前端的 ——
 * 关系字段（place/near/reply_to）排在 text 前面，前端在第一个字到达时就知道这条
 * 贴着谁，能先把框立在锚旁边再让正文流进去。抽取规则在 tool-input-stream.js。
 */
/** 落位意图（2026-09-05）：只说关系，像素由 lib/board-place.js 解 */
export const PLACE = z.object({
  by: z.string().max(300).optional()
    .describe("Put it next to THIS: a canvas id / #tag / board-note path, 'user' = what the user has selected, 'view' = free ground in the user's current view (the default when nothing is given)"),
  side: z.enum(['right', 'left', 'below', 'above']).optional()
    .describe('Preferred side of `by`. A preference, not an order: if that side is taken it goes to the nearest free side and the return says so'),
  with: z.string().regex(TAG_RE).optional()
    .describe('Continue THIS group: lands right under the last note of that #tag (a running thread grows downward)'),
}).describe('WHERE, in relations — no pixels. Omit it to land in the user\'s view');

export const WRITE_SCHEMA = {
  place: PLACE.optional(),
  near: z.string().max(300).optional()
    .describe('Canvas id or #tag this is ABOUT — draws an annotates line to it and, unless place says otherwise, lands beside it'),
  reply_to: z.string().max(300).optional().describe(`Thread: path of a board note (${CHALK_DIR}/…md) to answer under (lands right below it)`),
  text: z.string().min(1).max(8000).optional()
    .describe('The one-note shorthand: a short Markdown note (= a 1-piece board write). Give text OR nodes/shapes, not both'),
  width: z.enum(['narrow', 'normal', 'wide']).optional()
    .describe('Measure of a single note: narrow (~12 CJK chars/line, a caption or a label), normal (~18 chars/line, the default), wide (~26 chars/line, a table or a list). The box grows with the content — never pass a height'),
  flow: z.boolean().optional()
    .describe('For a ready-made long text: the machine splits it at paragraph breaks into a chain of card-sized notes threaded downward. Prefer writing several short notes yourself — a board note explains one thing'),
  relation: z.enum(BINDING_TYPE_IDS).optional()
    .describe('Line type for the near line of a single note (default annotates; flow reads anchor→note)'),
  chain: z.boolean().optional()
    .describe('Single note: auto reply_to the latest board note of the same tag WRITTEN BY YOU (threads never cross authors — continuation rights)'),
  open_lane: z.string().max(300).optional()
    .describe("Open a NEW thread line named by tag and land this note at its head. Value: a canvas id/#tag to BRANCH from (draws a flow line from it, lands beside it), or 'fresh' for a brand-new topic (lands in the user's view). Requires tag; continue with {tag, chain:true}."),
  tag: z.string().regex(TAG_RE).optional()
    .describe('Group tag. A 1-piece write stays untagged unless you pass one; ≥2 pieces auto-tag sk-<stamp>'),
  ink: z.enum(['chalk', 'hand']).optional()
    .describe("Single note body: 'chalk' (default) = a real file under notes/板书 (Read/Edit later; chain/reply threads live on these); 'hand' = canvas-native handwritten text — a light remark like the user's own handwriting, no file, no threading"),
  font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional().describe("Single note font (ink:'hand'; default kai)"),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional().describe("Single note color (ink:'hand')"),
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe("Single note text size. Real for ink:'hand'; for chalk notes it only sizes the placement box (chalk renders at a fixed size)"),
  title: z.string().max(60).optional().describe('Sketch: optional heading written at the top'),
  layout: z.enum(['auto', 'free', 'column', 'row', 'grid', 'mindmap', 'flow']).optional()
    .describe('Sketch layout. auto FOLLOWS YOUR EDGES: with edges it lays out in flow layers (roots on top, children below — give edges and placement is structure); mindmap picks the hub by degree. free needs at on EVERY node'),
  cols: z.number().int().min(1).max(8).optional().describe('grid columns'),
  staging: z.boolean().optional().describe('Sketch only: default true (translucent until commit/turn end). Ignored for single notes — they always land solid'),
  nodes: NODES.optional(),
  shapes: SHAPES.optional(),
  edges: EDGES.optional(),
};

/** width 三档 → 格数（1 格 = 24px）。判据是每行汉字数：字 16px，行内边距吃掉约 1 格 */
export const WIDTH_UNITS = Object.freeze({ narrow: 10, normal: 14, wide: 18 });
