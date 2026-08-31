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
  z.object({ op: z.literal('follow'), group_tag: z.string().min(1).max(40).describe('the group that should follow (e.g. a status panel)'), target_tag: z.string().min(1).max(40).describe('whenever a new item with this tag lands, the group auto-moves beside it and the anchor line re-points'), side: z.enum(['right', 'left', 'above', 'below']).optional(), keep_offset: z.boolean().optional().describe('true = do NOT snap the group beside the target now; leave it where it is and keep that offset from here on (every later hop is a parallel shift anyway)'), label: z.string().max(60).optional() }),
  z.object({ op: z.literal('set_tag'), ids: z.array(z.string().min(1).max(300)).min(1).max(24).describe('canvas ids (paths for files: images, sites, docx, notes — or node handles)'), tag: z.string().max(40).describe('group tag to put them in; "" removes the tag') }),
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

/**
 * 工具说明（2026-08-31 从 edit-board.js 迁来 —— 行数棘轮 620 > 600，按规矩拆）。
 *
 * 它跟 OP 是一件东西的两半：schema 说**能传什么**，这段说**什么时候用哪个、
 * 语义边界在哪**。放在同一份文件里，加一个 op 时两半在同一屏内，漏改一半的
 * 概率最小 —— 「描述声称做了、代码没做」在这个仓库已经犯过三次。
 */
export const EDIT_BOARD_DESC = `Edit what is already on the board — by id, without redrawing. Positions: sheet-absolute
{x,y,sheet?} (pixels from a sheet's top-left writable corner — you own the layout),
relative {ref, side, gap}, or a shift {dx,dy}. Every distance is in PIXELS — the same
pixels read_board and look_at_board report back, no grid conversion. Placement is EXACT
(no auto-nudging); if you cover something the return says so. ids come from read_board
(nodes text:…/scribble:…, cards deck:…/site:…/paths, lines b:…); local names from the
sketch that drew them work too.
ops (run in order; a failing op is reported, the rest still apply):
 set_text{id,text?,…} (canvas text nodes AND your own board-note files — a note's body is
 rewritten in place, threads/lines/annotations survive; never redraw to change words) ·
 move{id,to} · move_group{tag,to} (a tagged panel is ONE thing — move the whole status
 board with its tag, never its members one by one; pair with reflow to re-stack it) ·
 remove{id} (agent-written board
 notes included: file + seat + lines go together) · add_node{id?,text,at:{ref,side,gap?},…} ·
 add_shape{kind,around,…} (circle/box/underline an EXISTING thing after the fact — the mark
 hugs it and follows when it moves) · set_shape{id,color?,width?} ·
 add_edge{from,to,type?,material?,label?} · set_edge{id,from?,to?,label?,type?,material?}
 (re-point a line in one op) · remove_edge{id} · reflow{tag,layout?} (restack a group after
 text edits changed heights) · replan{sheet?,plan:[{slot,at,w,h,about}…]} (ADD or RESIZE planned
 blocks on an existing sheet — fix a bad layout instead of abandoning the page; unnamed slots stay) ·
 transform_group{tag,scale?,rotate?} (scale/rotate a whole tagged drawing about its center —
 scribbles truly transform; text/cards just re-seat, reported honestly) ·
 set_tag{ids,tag} (put ANYTHING already on the board into a group — images, sites, docx, cards.
 Tags are otherwise only settable when a thing is created, and produced files are never created
 by you, so this is how an artifact joins a group or becomes a follow target) ·
 follow{group_tag,target_tag,side?,keep_offset?} (standing rule: whenever a
 new item with target_tag lands, the group auto-moves beside it — a status panel that tracks
 the latest chapter needs this ONCE, not per turn. It is a PARALLEL SHIFT: the group keeps
 whatever offset it has, so if the group lands on top of something, just move it once —
 the new offset is kept from then on. Do NOT unfollow to fix an overlap.
 keep_offset:true skips even the first snap — the group stays exactly where it is and that
 becomes the baseline offset.) · unfollow{group_tag} ·
 commit{tag?} (staging → solid) · erase_group{tag} ·
 roll{tag,label?} (STOW a finished scene/act/chapter behind one compact scroll card —
 seats/files/lines all kept, user or you can unroll anytime; the tidy way to end an act) ·
 unroll{tag} · feature{id} / unfeature (hero) ·
 chalk_edit{on} (flip the user's 改板书 toggle — turn it ON when the session leans on
 board notes, e.g. blackboard RP, so the user can drag/edit notes without double-click arming).
Moves avoid collisions (nearest free cell). User-dragged items CAN be moved (the result
says so when you do) — move them for a reason, and never tug-of-war: if the user drags
it back, that placement is final.
For brand-new content use write_on_board.`;
