/**
 * edit_board 的 ops schema（2026-08-30 从 edit-board.js 拆出 —— 行数棘轮）。
 * 纯数据；弱模型方言垫片（$text 剥壳）与坐标钳制都住在这里。
 */

import { z } from 'zod';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { REFLOW_LAYOUTS } from '../../../lib/board-reflow.js';

/** 弱模型方言垫片：免费档模型给字符串字段裹 {$text:"…"} 壳（27/61 条真实错误，
 *  且读不懂 zod 报文会原样重试到死）。单键 $text 自动剥壳，合法对象碰不到。 */
const unwrapText = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  && typeof v.$text === 'string' && Object.keys(v).length === 1) ? v.$text : v;
const ENDPOINT = z.preprocess(unwrapText, z.string().min(1).max(300));

/** 退役的像素写法（09-05 起位置只收关系）。带了就明说，不让 strictObject 只回一句 Unrecognized key */
const PIXEL_KEYS = ['x', 'y', 'dx', 'dy', 'gap'];
export const PIXEL_KEYS_MESSAGE = 'Positions take relations only (by / side / with) — pixel coordinates (x, y, dx, dy) and gap are no longer accepted. '
  + "Say WHERE: {by:'<id|#tag|user|view>', side?:'right|left|above|below'} or {with:'<tag>'}. / 位置现在只收关系（by / side / with），不收像素坐标与 gap";

/**
 * 落位意图（2026-09-05）：move / move_group / add_node 都只收关系，像素由
 * lib/board-place.js 解。旧方言 `ref` 当 `by` 认（垫片，不是静默丢）。
 * 09-17（问题库 iss_mtfh3t44_kjdf 参数族）：旧写法里的 x/y/dx/dy/gap 原来只得到 `Unrecognized key: "gap"`，
 * agent 读不出「现在只收关系」，换个像素写法接着试。这里给一句明确的报错；不静默丢 —— 丢掉 gap
 * 等于只执行了半个意图（feedback：入参不许静默丢）。
 */
export const TO = z.preprocess(
  (v, ctx) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const pixel = PIXEL_KEYS.filter((k) => k in v);
    if (pixel.length) {
      ctx.addIssue({ code: 'custom', message: `${PIXEL_KEYS_MESSAGE}（收到了：${pixel.join(', ')}）` });
      return z.NEVER;
    }
    if (typeof v.ref === 'string' && v.by === undefined) {
      const { ref, ...rest } = v; return { ...rest, by: ref };
    }
    return v;
  },
  z.strictObject({
    // 09-18：这三句说明原来各有一整句，而 TO 被 7 个 op 各嵌一遍（JSON Schema 不共享定义），光它就占常驻
    // 两千多字符。怎么写位置在工具说明开头讲一次就够，这里只留提示词
    by: z.string().max(300).optional().describe("id / #tag / 'user' (their selection) / 'view' (their view)"),
    side: z.enum(['right', 'left', 'above', 'below']).optional(),
    with: z.string().regex(TAG_RE).optional().describe('continue this #tag group'),
  }),
).describe('WHERE, as a relation (no pixels)');

export const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_text'), id: z.string().min(1).max(300), text: z.string().min(1).max(8000).optional(), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional() }),
  z.object({ op: z.literal('move'), id: z.string().min(1).max(300), to: TO }),
  z.object({ op: z.literal('move_group'), tag: z.string().min(1).max(40), to: TO }),
  z.object({ op: z.literal('remove'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('add_node'), id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional().describe('local handle for later ops of this call. ASCII only (letters/digits/_/-, e.g. "n1"); the Chinese name goes in text'), text: z.string().min(1).max(8000), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), at: TO.optional().describe("Omit = into the user's view (same default as write_on_board)"), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('add_edge'), from: ENDPOINT.describe('canvas id as read_board prints it (site:…, docx:…, a path, a folder, a node handle) — must be something drawn on the board'), to: ENDPOINT.describe('same as from'), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), label: z.string().max(60).optional(), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('set_edge'), id: z.string().min(1).max(300), label: z.string().max(60).optional(), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), from: ENDPOINT.optional().describe('re-point the line: new source end'), to: ENDPOINT.optional().describe('re-point the line: new target end') }),
  z.object({ op: z.literal('remove_edge'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('reflow'), tag: z.string().min(1).max(40), layout: z.enum(REFLOW_LAYOUTS).optional().describe('Default: the layout the group was drawn with (column if it never recorded one). Re-lays the group with its current lines and real sizes, keeping its top-left; its flow lines set the order'), cols: z.number().int().min(1).max(8).optional().describe('grid columns') }),
  z.object({ op: z.literal('follow'), group_tag: z.string().min(1).max(40).describe('an EXISTING tag on the board: the group that should follow (e.g. a status panel). Tag the items first (write_on_board.tag or set_tag)'), target_tag: z.string().min(1).max(40).describe('whenever a new item with this tag lands, the group auto-moves beside it and the anchor line re-points'), side: z.enum(['right', 'left', 'above', 'below']).optional(), keep_offset: z.boolean().optional().describe('true = do NOT snap the group beside the target now; leave it where it is and keep that offset from here on (every later hop is a parallel shift anyway)'), label: z.string().max(60).optional() }),
  z.object({ op: z.literal('set_tag'), ids: z.array(z.string().min(1).max(300)).min(1).max(24).describe('canvas ids (paths for files: images, sites, docx, notes — or node handles), or line ids b:… (a tagged line is erased with its group)'), tag: z.string().max(40).describe('group tag to put them in; "" removes the tag') }),
  z.object({ op: z.literal('unfollow'), group_tag: z.string().min(1).max(40) }),
  z.object({ op: z.literal('commit'), tag: z.string().max(40).optional().describe('make staging solid; omit tag = everything staging') }),
  z.object({ op: z.literal('erase_group'), tag: z.string().min(1).max(40).describe('delete the whole tagged group (notes/shapes/lines; artifact cards only lose the tag)') }),
  z.object({ op: z.literal('unroll'), tag: z.string().min(1).max(40).describe('expand a rolled group back — everything returns to its original seat') }),
  z.object({ op: z.literal('chalk_edit'), on: z.boolean().describe('true = turn ON the user-side 改板书 toggle (notes become freely draggable/editable for the user); false = back to guarded mode') }),
  // ── 09-18 并进来的（站主：「把现有的 board 编辑工具都整合到 edit_board」；实现在 edit-board-more.js）──
  z.object({ op: z.literal('pin'), path: z.string().min(1).max(300).optional(), paths: z.array(z.string().min(1).max(300)).min(1).max(12).optional(), to: TO.optional(), tag: z.string().max(40).optional(), as: z.enum(['row', 'column']).optional() }),
  z.object({ op: z.literal('into_folder'), ids: z.array(z.string().min(1).max(300)).min(1).max(16), folder: z.string().max(300), rewrite_refs: z.boolean().optional() }),
  z.object({ op: z.literal('arrange'), ids: z.array(z.string().min(1).max(300)).min(2).max(24), as: z.enum(['row', 'column', 'grid']).optional(), cols: z.number().int().min(1).max(8).optional(), to: TO.optional(), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('set_vars'), vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
  z.object({ op: z.literal('add_trend'), key: z.string().min(1).max(40), to: TO.optional() }),
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
 notes included: file + seat + lines go together; an artifact card whose file is already gone
 from disk — read_board marks it ⚠️ — loses only its seat) · add_node{id?,text,at:{by,side?},…} ·
 add_edge{from,to,type?,material?,label?} · set_edge{id,from?,to?,label?,type?,material?}
 (re-point a line in one op) · remove_edge{id} · reflow{tag,layout?,cols?} (re-lay a group with the
 layout it was drawn with — a grid stays a grid, a flow stays layered — using its current lines and
 sizes; its flow lines set the order. Use it after edits instead of moving members one by one) ·
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
 unroll{tag} (expand a group the user rolled up into a scroll card) ·
 chalk_edit{on} (flip the user's 改板书 toggle — turn it ON when the session leans on
 board notes, e.g. blackboard RP, so the user can drag/edit notes without double-click arming) ·
 pin{path|paths,to?,tag?,as?} (put an EXISTING file on the canvas. With to it lands on the desktop
 there, and a file that lives in a folder — generated images live in the 生成图 folder — is really
 MOVED to the workspace root: its .webp/.meta come along and every reference to it in pages and
 notes is rewritten. Without to it is surfaced inside its folder. paths[] lays several out in one go) ·
 into_folder{ids,folder} (really move files / folders into a folder, created if missing; "" =
 workspace root; references follow) ·
 arrange{ids,as?,cols?,to?,tag?} (lay several things out in the given order as a row / column /
 grid (default: row up to 4, grid beyond) with machine spacing, the whole block beside \`to\` or
 where the first one is; with tag they become one topic) ·
 set_vars{vars} (the state table — the note tagged 状态表: set only these cells, e.g.
 {"好感度": 5}; existing keys update, new ones append; the rest of the note stays byte-for-byte; never set_text a whole table to change one number; no table yet →
 write one with write_on_board tag:"状态表") ·
 add_trend{key,to?} (hand-inked trend of one numeric state-table key over the story, from git
 history; needs ≥2 points; calling it again redraws in place).
Same tag = one topic with its own ground (the dashed hull on the canvas). When a topic grows or
lands on another, the other topic moves out of the way as a whole — the result says who moved.
User-dragged items CAN be moved (the result says so when you do) — move them for a
reason, and never tug-of-war: if the user drags it back, that placement is final.
For brand-new content use write_on_board.`;
