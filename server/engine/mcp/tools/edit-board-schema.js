/**
 * edit_board 的 ops schema（2026-08-30 从 edit-board.js 拆出 —— 行数棘轮）。
 * 纯数据；弱模型方言垫片（$text 剥壳）与坐标钳制都住在这里。
 */

import { z } from 'zod';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { SLOT } from './open-sheet.js';

const clampTo = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : v);
const GAP = z.preprocess(clampTo(0, 400), z.number().min(0).max(400));
const PX_DELTA = z.preprocess(clampTo(-20000, 20000), z.number().min(-20000).max(20000));
/** 弱模型方言垫片：免费档模型给字符串字段裹 {$text:"…"} 壳（27/61 条真实错误，
 *  且读不懂 zod 报文会原样重试到死）。单键 $text 自动剥壳，合法对象碰不到。 */
const unwrapText = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  && typeof v.$text === 'string' && Object.keys(v).length === 1) ? v.$text : v;
const ENDPOINT = z.preprocess(unwrapText, z.string().min(1).max(300));

const REL = z.object({
  ref: z.string().min(1).max(300).describe('canvas id to place relative to'),
  side: z.enum(['right', 'left', 'above', 'below']),
  gap: GAP.optional().describe('PIXELS of breathing room between the two (default 24, max 400) — same unit as every position you read back'),
});
const DELTA = z.object({ dx: PX_DELTA, dy: PX_DELTA }).describe('PIXELS to shift by (+x right, +y down) — the same pixels read_board reports');
// 纸内绝对坐标（2026-08-29 纸范式）：以某张纸版心左上为原点的像素。sheet 缺省 = 当前纸
const ABS = z.object({
  x: z.preprocess((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(12000, v)) : v), z.number().min(0).max(12000)),
  y: z.preprocess((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(12000, v)) : v), z.number().min(0).max(12000)),
  sheet: z.string().max(40).optional().describe('which sheet these pixels are on (default the current one)'),
}).describe("PIXELS from a sheet's top-left writable corner — exact placement, you own the layout");
const TO = z.union([REL, ABS, DELTA]);

export const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_text'), id: z.string().min(1).max(300), text: z.string().min(1).max(8000).optional(), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional() }),
  z.object({ op: z.literal('move'), id: z.string().min(1).max(300), to: TO }),
  z.object({ op: z.literal('move_group'), tag: z.string().min(1).max(40), to: TO }),
  z.object({ op: z.literal('remove'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('add_node'), id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional().describe('local handle for later ops of this call'), text: z.string().min(1).max(8000), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), at: REL, tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('add_shape'), kind: z.enum(['rect', 'ellipse', 'circle', 'underline']), around: z.string().min(1).max(300).describe('canvas id to wrap/underline — the mark HUGS it and follows when it moves'), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), width: z.number().min(1).max(12).optional(), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('set_shape'), id: z.string().min(1).max(300), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), width: z.number().min(1).max(12).optional() }),
  z.object({ op: z.literal('add_edge'), from: ENDPOINT, to: ENDPOINT, type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), label: z.string().max(60).optional(), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('set_edge'), id: z.string().min(1).max(300), label: z.string().max(60).optional(), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), from: ENDPOINT.optional().describe('re-point the line: new source end'), to: ENDPOINT.optional().describe('re-point the line: new target end') }),
  z.object({ op: z.literal('remove_edge'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('reflow'), tag: z.string().min(1).max(40), layout: z.enum(['column', 'row']).optional().describe('default column: restack the group in reading order with real sizes (use after set_text changes heights)') }),
  z.object({ op: z.literal('follow'), group_tag: z.string().min(1).max(40).describe('the group that should follow (e.g. a status panel)'), target_tag: z.string().min(1).max(40).describe('whenever a new item with this tag lands, the group auto-moves beside it and the anchor line re-points'), side: z.enum(['right', 'left', 'above', 'below']).optional(), label: z.string().max(60).optional() }),
  z.object({ op: z.literal('unfollow'), group_tag: z.string().min(1).max(40) }),
  z.object({ op: z.literal('commit'), tag: z.string().max(40).optional().describe('make staging solid; omit tag = everything staging') }),
  z.object({ op: z.literal('erase_group'), tag: z.string().min(1).max(40).describe('delete the whole tagged group (notes/shapes/lines; artifact cards only lose the tag)') }),
  z.object({ op: z.literal('roll'), tag: z.string().min(1).max(40).describe('STOW a finished group: hides it behind a compact scroll card, everything kept in place (seats reserved, files intact, one click to unroll). For a scene/act/chapter that is DONE — use erase_group only to destroy'), label: z.string().max(60).optional().describe('scroll card title (default: the tag)') }),
  z.object({ op: z.literal('unroll'), tag: z.string().min(1).max(40).describe('expand a rolled group back — everything returns to its original seat') }),
  z.object({ op: z.literal('feature'), id: z.string().min(1).max(300).describe('make this the hero of the desktop') }),
  z.object({ op: z.literal('unfeature') }),
  z.object({ op: z.literal('transform_group'), tag: z.string().min(1).max(40), scale: z.number().min(0.3).max(3).optional(), rotate: z.number().min(-180).max(180).optional().describe('degrees clockwise') }),
  z.object({ op: z.literal('replan'), sheet: z.string().max(40).optional().describe('which sheet (default: the current one)'), plan: z.array(SLOT).min(1).max(24).describe('slots to ADD or RESIZE on an existing sheet (merged by name; slots you do not mention stay). Same local-pixel coordinates as open_sheet{plan}') }),
  z.object({ op: z.literal('chalk_edit'), on: z.boolean().describe('true = turn ON the user-side 改板书 toggle (notes become freely draggable/editable for the user); false = back to guarded mode') }),
]);
