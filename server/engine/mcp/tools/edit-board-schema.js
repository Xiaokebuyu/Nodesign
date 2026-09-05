/**
 * edit_board 的 ops schema（2026-08-30 从 edit-board.js 拆出 —— 行数棘轮）。
 * 纯数据；弱模型方言垫片（$text 剥壳）与坐标钳制都住在这里。
 */

import { z } from 'zod';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';

/** 弱模型方言垫片：免费档模型给字符串字段裹 {$text:"…"} 壳（27/61 条真实错误，
 *  且读不懂 zod 报文会原样重试到死）。单键 $text 自动剥壳，合法对象碰不到。 */
const unwrapText = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  && typeof v.$text === 'string' && Object.keys(v).length === 1) ? v.$text : v;
const ENDPOINT = z.preprocess(unwrapText, z.string().min(1).max(300));

/**
 * 落位意图（2026-09-05）：move / move_group / add_node 都只收关系，像素由
 * lib/board-place.js 解。旧方言 `ref` 当 `by` 认（垫片，不是静默丢）。
 */
export const TO = z.preprocess(
  (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.ref === 'string' && v.by === undefined) {
      const { ref, ...rest } = v; return { ...rest, by: ref };
    }
    return v;
  },
  z.strictObject({
    by: z.string().max(300).optional()
      .describe("Next to THIS: a canvas id / #tag / board-note path, 'user' = what the user has selected, 'view' = free ground in the user's current view"),
    side: z.enum(['right', 'left', 'above', 'below']).optional()
      .describe('Preferred side of `by` — a preference: if it is taken the thing goes to the nearest free side and the return says so'),
    with: z.string().regex(TAG_RE).optional()
      .describe('Continue THIS group: right under the last item of that #tag'),
  }),
).describe("WHERE, in relations — no pixels. {by:'view'} = into the user's view");

export const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_text'), id: z.string().min(1).max(300), text: z.string().min(1).max(8000).optional(), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional() }),
  z.object({ op: z.literal('move'), id: z.string().min(1).max(300), to: TO }),
  z.object({ op: z.literal('move_group'), tag: z.string().min(1).max(40), to: TO }),
  z.object({ op: z.literal('remove'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('add_node'), id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional().describe('local handle for later ops of this call'), text: z.string().min(1).max(8000), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), at: TO, tag: z.string().max(40).optional() }),
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
  z.object({ op: z.literal('chalk_edit'), on: z.boolean().describe('true = turn ON the user-side 改板书 toggle (notes become freely draggable/editable for the user); false = back to guarded mode') }),
]);

/**
 * 工具说明（2026-08-31 从 edit-board.js 迁来 —— 行数棘轮 620 > 600，按规矩拆）。
 *
 * 它跟 OP 是一件东西的两半：schema 说**能传什么**，这段说**什么时候用哪个、
 * 语义边界在哪**。放在同一份文件里，加一个 op 时两半在同一屏内，漏改一半的
 * 概率最小 —— 「描述声称做了、代码没做」在这个仓库已经犯过三次。
 */
export const EDIT_BOARD_DESC = `Edit what is already on the board — by id, without redrawing. Positions are
RELATIONS, never pixels: to:{by:"<id|#tag|user|view>", side?, with?} — beside something
(side is a preference; if taken it goes to the nearest free side and the return says so),
into the user's view, or under the last item of a #tag group. The machine solves the
spot and never covers anything. ids come from read_board (nodes text:…/scribble:…,
cards deck:…/site:…/paths, lines b:…); local names from the sketch that drew them work too.
ops (run in order; a failing op is reported, the rest still apply):
 set_text{id,text?,…} (canvas text nodes AND your own board-note files — a note's body is
 rewritten in place, threads/lines/annotations survive; never redraw to change words) ·
 move{id,to} · move_group{tag,to} (a tagged panel is ONE thing — move the whole panel
 with its tag, never its members one by one; pair with reflow to re-stack it) ·
 remove{id} (agent-written board
 notes included: file + seat + lines go together) · add_node{id?,text,at:{by,side?},…} ·
 add_shape{kind,around,…} (circle/box/underline an EXISTING thing after the fact — the mark
 hugs it and follows when it moves) · set_shape{id,color?,width?} ·
 add_edge{from,to,type?,material?,label?} · set_edge{id,from?,to?,label?,type?,material?}
 (re-point a line in one op) · remove_edge{id} · reflow{tag,layout?} (restack a group after
 text edits changed heights) ·
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
User-dragged items CAN be moved (the result says so when you do) — move them for a
reason, and never tug-of-war: if the user drags it back, that placement is final.
For brand-new content use write_on_board.`;
