/**
 * write_on_board 的图形入参 schema（2026-08-28 从 write-on-board.js 拆出 —— 行数棘轮；
 * 纯数据，跟落板逻辑零耦合）。上限是失控兜底不是风格闸：zod 硬拒（-32602 整调用作废）
 * 是最贵的失败模式，可读性走返回值里的软提醒（08-25 用户拍板「移除画板上限」）。
 */

import { z } from 'zod';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { CHALK_DIR } from '../../../lib/chalk.js';

const MAX_NODES = 200;
const MAX_SHAPES = 120;
const MAX_EDGES = 400;

const LOCAL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/, 'local id: letters/digits/_/-');
const GRID_PT = z.object({ x: z.number().min(-2000).max(2000), y: z.number().min(-2000).max(2000) });
export const WORLD_PT = z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6) });
/**
 * 纸内坐标（2026-08-29 纸范式）：以当前纸版心左上角为原点的像素。越界**钳住不拒收**
 * （schema 整单拒是最贵的失败模式；钳过在返回里如实报）。preprocess 在给模型看的
 * JSON schema 里隐形 —— 文档照旧严格，垫片只当安全网。
 */
const clampN = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : v);
export const SHEET_PT = z.object({
  x: z.preprocess(clampN(0, 12000), z.number().min(0).max(12000)),
  y: z.preprocess(clampN(0, 12000), z.number().min(0).max(12000)),
});

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
  kind: z.enum(['rect', 'ellipse', 'circle', 'line', 'arrow', 'underline', 'path']),
  at: GRID_PT.optional(),
  around: LOCAL_ID.optional().describe('rect/ellipse/circle/underline: wrap this node instead of at/w/h'),
  w: z.number().min(0).max(200).optional(),
  h: z.number().min(0).max(200).optional(),
  to: GRID_PT.optional(),
  toNode: LOCAL_ID.optional(),
  d: z.string().max(8000).optional().describe('path kind: SVG M/L/Q/Z in local px'),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
  width: z.number().min(1).max(12).optional(),
})).max(MAX_SHAPES);

export const EDGES = z.array(z.object({
  from: z.string().min(1).max(300).describe('local node id or canvas id'),
  to: z.string().min(1).max(300).describe('local node id or canvas id'),
  type: z.enum(BINDING_TYPE_IDS).optional().describe('default link'),
  material: z.enum(BINDING_MATERIALS).optional().describe('default pencil'),
  label: z.string().max(60).optional(),
})).max(MAX_EDGES);

/**
 * ⚠️ 字段顺序有意义（2026-08-29 占位契约刀 C）：模型是按 schema 声明顺序生成
 * JSON 的，而入参是**流式**到达前端的 —— 位置字段排在 text 前面，画布才能在
 * 第一个字到达时就把框立在真位置上，让正文流进去（排在后面的话，字已经流完了
 * 位置才到，只能先画在一块空地上再跳过去 —— 那正是这一刀要治的）。
 * 抽取规则在 agent-shared.js 的 TOOL_INPUT_STREAM_FIELDS.spot。
 */
export const WRITE_SCHEMA = {
  slot: z.string().regex(TAG_RE).optional()
    .describe('Drop this into a PLANNED BLOCK of the current sheet (names come from open_sheet{plan}). The block decides the width and where it lands; notes stack downward inside it. If it does not fit, the write is REFUSED with how much room is left — split the content or re-plan. Prefer this over at: plan the page first, then fill it.'),
  at: SHEET_PT.optional()
    .describe("Where on the CURRENT SHEET, in pixels from its top-left writable corner (x→right, y→down). Clamped into the sheet — the return says if it was. Omit it to flow top-to-bottom"),
  sheet: z.string().regex(TAG_RE).optional()
    .describe('Write on this sheet instead of the current one (names from open_sheet / read_board)'),
  width: z.number().min(8).max(60).optional().describe('Single note width in grid units (24px). Default: the width the user last dragged chalk blocks to, else by content. Omit it unless this one block needs a different measure - the default already follows the user.'),
  near: z.string().max(300).optional()
    .describe('Canvas id or #tag this is ABOUT — draws an annotates line to it. Placement itself is by sheet (at / flow), not by near'),
  side: z.enum(['right', 'left', 'above', 'below']).optional()
    .describe('ONLY with near, when the SEMANTICS demand a side (e.g. a caption must sit above): exact placement beside the anchor. Normally omit — sheets flow downward'),
  reply_to: z.string().max(300).optional().describe(`Thread: path of a board note (${CHALK_DIR}/…md) to answer under (lands right below it; a full sheet turns the page)`),
  text: z.string().min(1).max(8000).optional()
    .describe('The one-note shorthand: a short Markdown note (= a 1-piece board write). Give text OR nodes/shapes, not both'),
  flow: z.boolean().optional()
    .describe('Long text? Set true and the MACHINE splits it at paragraph breaks into a chain of card-sized notes, packing them into the slot/sheet as far as they fit — what does not fit is returned to you untouched (never squeezed, never silently dropped, never auto-turning the page). Use this instead of guessing whether your text fits.'),
  h: z.number().min(24).max(2000).optional()
    .describe('Reserve this HEIGHT in pixels for the note box, placed before the text settles (plan the box, then fill it). Shorter content keeps the box; longer content overrides it. Ignored with flow.'),
  relation: z.enum(BINDING_TYPE_IDS).optional()
    .describe('Line type for the near line of a single note (default annotates; flow reads anchor→note)'),
  chain: z.boolean().optional()
    .describe('Single note: auto reply_to the latest board note of the same tag WRITTEN BY YOU (threads never cross authors — continuation rights)'),
  open_lane: z.string().max(300).optional()
    .describe("Open a NEW thread line named by tag: lays a fresh sheet for it and lands this note at its head. Value: a canvas id/#tag to BRANCH from (draws a flow line from it), or 'fresh' for a brand-new topic. Requires tag; continue with {tag, chain:true}."),
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
