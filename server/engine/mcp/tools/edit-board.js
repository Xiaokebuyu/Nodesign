/**
 * mcp/tools/edit-board.js —— edit_board（2026-08-25 范式重做③）
 *
 * 改板的唯一入口。前身 edit_sketch，08-25 这一刀吞进四件；旧名薄别名 08-28 全部
 * 收摊（exp 不为过去的会话背兼容，用户拍板）：
 *   arrange_on_board  → feature / unfeature（beside/below = move 的 to:{ref,side}）
 *   finish_sketch     → commit / erase_group
 *   relate_on_board   → add_edge（它独有的"端点必须真实存在"校验下沉进共享 add_edge
 *                       —— 原来一个查一个不查是口径病，悬空线全从不查的那个进来）
 *   edit_sketch       → 本体改名
 *
 * 新能力（08-25 RP 真会话那批 friction 的正面回答）：
 *   set_edge 支持改端点 from/to（「状态锚在这一章」重指一条命令，不再 remove+add）
 *   reflow{tag}       set_text 改高后整组按 column/row 重堆（agent 不该自带补丁模板）
 *   remove            对 agent 自己写的板书放行（连文件带座位带线一起清）
 *   move              有避让了（原 placeRel 裸落点，是六套引擎里唯一不避让的）
 *
 * 位置永远是相对表达（{ref,side,gap} 或位移 {dx,dy}），落到哪一格由服务端解析。
 * 距离单位一律像素（08-29；此前是格，见下面 GAP/PX_DELTA 那段的账）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf } from '../actor.js';
import { z } from 'zod';
import { readBoard, patchBoard, commitStaging, removeByTag, chalkAbsPath, TEXT_FONTS } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { BINDING_TYPES, BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { UNIT, textBox, shapePath } from '../../../lib/sketch-layout.js';
import { placeBeside, placeAtOnSheet, overlapIds, currentSheet } from '../../../lib/board-sheets.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { CHALK_DIR, trashChalkFile, parseChalk, renderChalk } from '../../../lib/chalk.js';
import { readUiConfigFile, writeUiConfig } from '../../../projects/ui-config.js';

const MAX_OPS = 120;
let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

/**
 * 距离一律**像素**（2026-08-29 改口径）。原来 gap/dx/dy 是格（1 格 24px），配了一层
 * 「大于上限的按像素收编」的垫片 —— 于是同一个字段小数当格、大数当像素，中间那段
 * 静默错 24 倍：真会话里 agent 想左移 120px 写了 dx:-120，实际挪了 2880px，再写
 * dx:7000（这次按像素算）往回捞，四发才收敛（proj_mtdr2xpa 03:09）。
 *
 * agent 读到的每一个位置都是像素（read_board / look_at_board / 落位回执全是），
 * 让它写位移时换算成格，是给一件没有收益的事发一张必错的许可证。格只留在起草图
 * （write_on_board 的 nodes[].at）那种「从零排版面」的场合。
 *
 * 超范围的值**钳住不拒收**（08-27 那条教训留着）：schema 校验是整单拒，一个越界的
 * gap 会陪葬同批全部合法 op —— 代价远大于把它按到上限。
 */
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

const OP = z.discriminatedUnion('op', [
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
  z.object({ op: z.literal('chalk_edit'), on: z.boolean().describe('true = turn ON the user-side 改板书 toggle (notes become freely draggable/editable for the user); false = back to guarded mode') }),
]);

export function makeEditBoardTool({ projectId, sharedRoot, sessionId = null, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, sessionId, ctx });
  return tool(
    'edit_board',
    `Edit what is already on the board — by id, without redrawing. Positions: sheet-absolute
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
 text edits changed heights) · follow{group_tag,target_tag,side?} (standing rule: whenever a
 new item with target_tag lands, the group auto-moves beside it — a status panel that tracks
 the latest chapter needs this ONCE, not per turn) · unfollow{group_tag} ·
 commit{tag?} (staging → solid) · erase_group{tag} ·
 roll{tag,label?} (STOW a finished scene/act/chapter behind one compact scroll card —
 seats/files/lines all kept, user or you can unroll anytime; the tidy way to end an act) ·
 unroll{tag} · feature{id} / unfeature (hero) ·
 chalk_edit{on} (flip the user's 改板书 toggle — turn it ON when the session leans on
 board notes, e.g. blackboard RP, so the user can drag/edit notes without double-click arming).
Moves avoid collisions (nearest free cell). User-dragged items CAN be moved (the result
says so when you do) — move them for a reason, and never tug-of-war: if the user drags
it back, that placement is final.
For brand-new content use write_on_board.`,
    {
      tag: z.string().max(40).optional().describe('Default tag for add_node/add_edge (the group you are editing)'),
      ops: z.array(OP).min(1).max(MAX_OPS),
    },
    handler,
  );
}

/** 端点存在性（add_edge/set_edge 共用；08-28 起 write_on_board 的图内边也用它 ——
 *  两个入口对「悬空边」的容忍度曾不对称）：板上有座位 / zones 命中 / 磁盘上真有这个路径。 */
export async function endpointReal(id, live, zones, sharedRoot) {
  if (live[id]) return true;
  if (zones && zones[id] !== undefined) return true;
  // （doc: 无条件放行分支 08-27 审计拆除：doc:brand/_root 已于 08-24 退役，全仓
  //   无写方；留着它,手滑把 docx: 打成 doc: 就能绕过存在性闸产出悬空线）
  if (!sharedRoot) return false;
  const bare = id.replace(/^(deck|site|docx|text|scribble):/, '');
  if (!bare || bare.includes('..')) return false;
  try { await fs.access(path.join(sharedRoot, bare)); return true; } catch { return false; }
}

function makeHandler({ projectId, sharedRoot, sessionId = null, ctx }) {
  return async ({ tag: defaultTag, ops }, extra) => {
    // 署名按调用者（常驻角色改板时署它的名）——见 mcp/actor.js
    const by = byOf(extra);
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (!projectId) return err('No project bound.');
    const board = await readBoard(projectId);
    const known = new Set(Object.keys(board.zones || {}));
    const objects = {}; const bindings = {};      // 增量 patch
    const rolls = {};                              // 卷（收纳器）：tag → {at,by,label}|null
    const live = { ...board.objects };             // 调用内"当前态"
    const liveBindings = { ...board.bindings };
    const local = new Map();                       // add_node 本地句柄 → canvas id
    let heroPatch;                                 // undefined = 不动；null = 撤；string = 立
    const chalkUnlinks = [];                       // remove 板书：patch 后再删文件
    let committed = 0; let erased = 0;

    const byLid = (raw) => {
      const hits = Object.entries(live).filter(([, e]) => e?.data?.lid === raw && Number.isFinite(e?.x));
      if (!hits.length) return null;
      const scoped = defaultTag ? hits.filter(([, e]) => e.tag === defaultTag) : [];
      const pick = (scoped.length ? scoped : hits);
      return pick[pick.length - 1][0];
    };
    const rid = (raw) => {
      if (local.has(raw)) return local.get(raw);
      const c = normalizeCanvasId(raw);
      if (c && live[c]) return c;
      return byLid(raw);
    };
    const rectOf = (id) => { const e = live[id]; return e ? { x: e.x, y: e.y, ...estimateSizeOn(board, id, e) } : null; };
    /** 压上判定的障碍集（同层，subject/组员除外；含文件夹卡/卷卡/精灵身位） */
    const obstaclesNear = (zone, exclude = new Set()) => obstaclesIn(board, zone, { objects: live, exclude });
    /** 相对落位 = 精确贴放（2026-08-29：环搜退役 —— 压上如实报，不代找洞） */
    const placeRel = (subjectId, box, rel) => {
      const refId = rid(rel.ref);
      const r = rectOf(refId);
      if (!r) return null;
      const zone = layerOf(refId, live[refId], known);
      const p = placeBeside(r, box, rel.side, rel.gap ?? UNIT);
      const pressed = overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h }, obstaclesNear(zone, new Set([subjectId])));
      return { ...p, pressed };
    };
    /** 纸内绝对坐标 → 世界（sheet 缺省当前纸；钳进版心，钳了如实报） */
    const placeAbs = (to, box) => {
      const s = to.sheet && board.sheets?.[to.sheet]
        ? { id: to.sheet, ...board.sheets[to.sheet] }
        : currentSheet(board, currentSheetIdOf(sessionId));
      if (!s) return null;
      const p = placeAtOnSheet(s, { x: to.x, y: to.y }, box);
      return { ...p, sheetId: s.id };
    };
    const report = []; let ok = 0;
    const setObj = (id, e) => { live[id] = e; objects[id] = e; };
    /** 贴身记号跟随（08-27 shapes 编辑面）：挪一件东西时，圈着它的涂鸦一起走。
     *  except = 这次已经被挪过的 id 集（整组拖时组员别被挪两次）。 */
    const moveHuggers = (nodeId, dx, dy, except = null) => {
      if (!dx && !dy) return;
      for (const [hid, he] of Object.entries(live)) {
        if (he?.hug !== nodeId || he.kind !== 'scribble') continue;
        if (except?.has(hid)) continue;
        setObj(hid, { ...he, x: he.x + dx, y: he.y + dy });
      }
    };

    for (let i = 0; i < ops.length; i += 1) {
      const o = ops[i];
      const fail = (why) => report.push(`✗ #${i + 1} ${o.op}: ${why}`);
      try {
        if (o.op === 'set_text') {
          const id = rid(o.id); const e = id && live[id];
          // 板书正门（08-27）：set_text 也认板书**文件** —— 改字不再要求重画/绕道
          // Edit。笔权按作者判：只有作者本人能改自己的话（接续权闸的同一条纪律，
          // 角色因此第一次拥有了改自己板书的手）。
          if (e && !e.kind && id.startsWith(`${CHALK_DIR}/`)) {
            if ((e.by || 'agent') !== by) { fail(`这条板书是「${e.by || 'agent'}」写的，笔权在它 —— 想让它改，寄 cue（SendMessage）或让用户直接说。`); continue; }
            if (!o.text) { fail('改板书给 text（字号/字体/颜色是画布原生节点的旋钮，板书没有）'); continue; }
            const abs = chalkAbsPath(projectId, id);
            if (!abs) { fail(`${id} 的文件路径解析不了`); continue; }
            let parsed;
            try { parsed = parseChalk(await fs.readFile(abs, 'utf8')); } catch { fail(`${id} 文件读不到（磁盘上已无此路径？）`); continue; }
            const c = parsed.chalk || {};
            await fs.writeFile(abs, renderChalk({
              body: o.text, by: c.by || e.by || 'agent',
              ...(c.at ? { at: c.at } : {}),
              anchor: c.anchor, replyTo: c.replyTo, tag: c.tag, sessionId: parsed.sessionId,
            }), 'utf8');
            const box2 = textBox(o.text, 'md', { md: true, wUnits: Math.max(8, Math.round((e.w || 432) / UNIT)) });
            // 宽照旧沿用现有的（改正文不该改版心）；高按新正文重算，但**用户亲手
            // 拖出来的留白留得住**（sized:'user' 时取两者较大的）—— 他调的是
            // 「这一块留多少空」，重写一次正文就把它抹掉是把他的排版意图当缓存。
            const h2 = e.sized === 'user' ? Math.max(box2.h, Number(e.h) || 0) : box2.h;
            setObj(id, { ...e, w: box2.w, h: h2 }); ok += 1;
            report.push(`· #${i + 1} set_text 重写了板书 ${id} 的正文（线/标注/座位全保留）`);
            continue;
          }
          if (!e || e.kind !== 'text') { fail(`${o.id} 不是文字节点，也不是你的板书文件`); continue; }
          const data = { ...e.data };
          if (o.text) data.t = o.text;
          if (o.format) { if (o.format === 'md') data.format = 'md'; else delete data.format; }
          if (o.size) data.size = o.size; if (o.color) data.color = o.color; if (o.font && TEXT_FONTS.includes(o.font)) data.font = o.font;
          const box = textBox(data.t, data.size || 'md', { md: data.format === 'md' });
          setObj(id, { ...e, data, w: box.w, h: box.h }); ok += 1;
        } else if (o.op === 'move') {
          const id = rid(o.id); const e = id && live[id];
          if (!e) { fail(`${o.id} 不在板上`); continue; }
          // seat:'user' 08-28 从「冻结」放开（用户拍板"全部放开试试"）：排位引擎
          // 已经能按用户手感排（inferFlowDir 学票、自动挑侧），硬拒的最大受害者
          // 是用户自己（"帮我挪一下"被 agent 顶回"你自己拖"）。放开但**如实报**：
          // 挪的是他亲手摆的东西，agent 得心里有数、他不认可拖回去就是。
          const wasUser = e.seat === 'user' ? '（原是用户亲手摆的，已挪 —— 他不认可会拖回去）' : '';
          const box = rectOf(id);
          if ('ref' in o.to) {
            const p = placeRel(id, box, o.to);
            if (!p) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            setObj(id, { ...e, x: Math.round(p.x), y: Math.round(p.y), seat: 'agent' });
            moveHuggers(id, Math.round(p.x) - e.x, Math.round(p.y) - e.y);
            report.push(`· #${i + 1} move → (${Math.round(p.x)},${Math.round(p.y)})${p.pressed?.length ? `（⚠ 压住了 ${p.pressed.slice(0, 3).join('、')}）` : ''}${wasUser}`);
          } else if ('x' in o.to) {
            const p = placeAbs(o.to, box);
            if (!p) { fail(o.to.sheet ? `纸 ${o.to.sheet} 不存在（read_board 看纸的清单）` : '还没有铺过纸 —— 先 open_sheet，或用 {dx,dy}/{ref,side}'); continue; }
            setObj(id, { ...e, x: p.x, y: p.y, seat: 'agent' });
            moveHuggers(id, p.x - e.x, p.y - e.y);
            report.push(`· #${i + 1} move → 纸 ${p.sheetId} (${p.x},${p.y})${p.clamped ? '（越界，钳进了版心）' : ''}${wasUser}`);
          } else {
            const nx = Math.round(e.x + o.to.dx); const ny = Math.round(e.y + o.to.dy);
            setObj(id, { ...e, x: nx, y: ny, seat: 'agent' });
            moveHuggers(id, nx - e.x, ny - e.y);
            report.push(`· #${i + 1} move → (${nx},${ny})${wasUser}`);
          }
          ok += 1;
        } else if (o.op === 'move_group') {
          const members = Object.entries(live).filter(([, e]) => e.tag === o.tag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const bb = { x: Math.min(...members.map(([, e]) => e.x)), y: Math.min(...members.map(([, e]) => e.y)) };
          const rects = members.map(([id]) => rectOf(id));
          const w = Math.max(...rects.map(r => r.x + r.w)) - bb.x; const h = Math.max(...rects.map(r => r.y + r.h)) - bb.y;
          let p; let pressed = [];
          if ('ref' in o.to) {
            const refId = rid(o.to.ref);
            const r = rectOf(refId);
            if (!r) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            const zone = layerOf(refId, live[refId], known);
            const memberIds = new Set(members.map(([id]) => id));
            p = placeBeside(r, { w, h }, o.to.side, o.to.gap ?? UNIT);
            pressed = overlapIds({ x: p.x, y: p.y, w, h }, obstaclesNear(zone, memberIds));
          } else if ('x' in o.to) {
            const pa = placeAbs(o.to, { w, h });
            if (!pa) { fail(o.to.sheet ? `纸 ${o.to.sheet} 不存在` : '还没有铺过纸 —— 先 open_sheet，或用 {dx,dy}/{ref,side}'); continue; }
            p = pa;
          } else {
            p = { x: bb.x + o.to.dx, y: bb.y + o.to.dy };
          }
          const dx = Math.round(p.x - bb.x); const dy = Math.round(p.y - bb.y);
          // 08-28 放开：user 座随组平移（相对格局原样保留，学 follow 平移跟随的先例）
          // —— 旧行为跳过用户件会把组撕开留一半在原地，那才是最丑的结果。如实报件数。
          const userSeated = members.filter(([, e]) => e.seat === 'user').map(([id]) => id);
          const movedSet = new Set(members.map(([id]) => id));
          for (const [id, e] of members) setObj(id, { ...e, x: e.x + dx, y: e.y + dy, ...(e.seat === 'user' ? {} : { seat: 'agent' }) });
          for (const [id] of members) moveHuggers(id, dx, dy, movedSet);
          if (userSeated.length) report.push(`· #${i + 1} move_group: 含用户亲手摆的 ${userSeated.length} 件（随组平移，相对格局保留）`);
          report.push(`· #${i + 1} move_group #${o.tag} → 组左上 (${Math.round(p.x)},${Math.round(p.y)})${pressed.length ? `（⚠ 压住了 ${pressed.slice(0, 3).join('、')}）` : ''}${p.clamped ? '（越界，钳进了版心）' : ''}`);
          ok += 1;
        } else if (o.op === 'remove') {
          const id = rid(o.id); const e = id && live[id];
          if (!e) { fail(`${o.id} 不在板上`); continue; }
          if (!e.kind) {
            // 板书文件卡：**agent 侧写的**放行（连文件），用户写的和普通产物卡拒。
            // 08-26：agent 侧现在有三类署名（主控 'agent' + 常驻角色 rp-*）。原来死比
            // 'agent'，于是角色写的板书谁都删不掉（连角色自己），报错还说那是「用户的板书」。
            if (id.startsWith(`${CHALK_DIR}/`) && e.by && e.by !== 'user') {
              const abs = chalkAbsPath(projectId, id);
              if (abs) chalkUnlinks.push(abs);
              delete live[id]; objects[id] = null; ok += 1; continue;
            }
            fail(`${id} 是${id.startsWith(`${CHALK_DIR}/`) ? '用户的板书' : '产物卡'}，不能从黑板删；整组擦用 erase_group`); continue;
          }
          delete live[id]; objects[id] = null; ok += 1;
        } else if (o.op === 'add_node') {
          const size = (o.size === 'sm' && o.text.length > 40) ? 'md' : (o.size || 'md');
          const box = textBox(o.text, size, { md: o.format === 'md' });
          const p = placeRel(null, box, o.at);
          if (!p) { fail(`参照 ${o.at.ref} 不在板上`); continue; }
          const refId = rid(o.at.ref);
          const zone = layerOf(refId, live[refId], known);
          const id = `text:a${stamp()}`;
          const tag = o.tag || defaultTag || live[refId]?.tag || null;
          setObj(id, {
            x: Math.round(p.x), y: Math.round(p.y), z: 1, w: box.w, h: box.h, kind: 'text',
            data: { t: o.text, ...(o.format === 'md' ? { format: 'md' } : {}), font: TEXT_FONTS.includes(o.font) ? o.font : 'pen', size, color: o.color || 'ink', ...(o.id ? { lid: o.id } : {}) },
            zone, by, seat: 'agent', ...(tag ? { tag } : {}),
          });
          if (o.id) local.set(o.id, id);
          report.push(`+ node ${o.id ? `${o.id}=` : ''}${id}`); ok += 1;
        } else if (o.op === 'add_shape') {
          // 事后圈重点（08-27 shapes 编辑面）：给**已在板上**的东西补一个手画记号。
          // hug 让它跟着目标走 —— 之前画完的圈是死的，目标一挪就散架。
          const refId = rid(o.around); const r = refId && rectOf(refId);
          if (!r) { fail(`around ${o.around} 不在板上`); continue; }
          const seed = `${refId}:m${stamp()}`;
          let sp; let ent;
          if (o.kind === 'underline') {
            sp = shapePath('underline', { to: { x: Math.max(8, r.w - 4), y: 0 } }, seed);
            ent = { x: Math.round(r.x + 2 - 6), y: Math.round(r.y + r.h - 2 - 6) };
          } else {
            const padPx = o.kind === 'rect' ? 8 : 14;
            let bx = { x: r.x - padPx, y: r.y - padPx, w: r.w + padPx * 2, h: r.h + padPx * 2 };
            if (o.kind === 'circle') { const dmax = Math.max(bx.w, bx.h); bx = { x: bx.x + (bx.w - dmax) / 2, y: bx.y + (bx.h - dmax) / 2, w: dmax, h: dmax }; }
            sp = shapePath(o.kind, { w: bx.w, h: bx.h }, seed);
            ent = { x: Math.round(bx.x - 6), y: Math.round(bx.y - 6) };
          }
          const sid = `scribble:a${stamp()}`;
          const tag2 = o.tag || defaultTag || live[refId]?.tag || null;
          setObj(sid, {
            ...ent, z: 1, w: Math.round(sp.w), h: Math.round(sp.h), kind: 'scribble',
            data: { d: sp.d, color: o.color || 'ink', width: o.width || 2 },
            by, seat: 'agent', hug: refId,
            ...(tag2 ? { tag: tag2 } : {}),
            zone: layerOf(refId, live[refId], known) || '',
          });
          report.push(`· #${i + 1} add_shape ${o.kind} 圈住 ${refId}（id ${sid}，会跟着它走）`);
          ok += 1;
        } else if (o.op === 'set_shape') {
          const id = rid(o.id); const e = id && live[id];
          if (!e || e.kind !== 'scribble') { fail(`${o.id} 不是手画记号（scribble）`); continue; }
          const data = { ...e.data };
          if (o.color) data.color = o.color;
          if (o.width) data.width = o.width;
          setObj(id, { ...e, data }); ok += 1;
        } else if (o.op === 'add_edge') {
          const from = rid(o.from) || normalizeCanvasId(o.from);
          const to = rid(o.to) || normalizeCanvasId(o.to);
          if (!from || !to || from === to) { fail(`端点不合法：${o.from} → ${o.to}`); continue; }
          // relate 下沉来的闸：两端都必须真实存在（板上有座 / doc: / 磁盘真身）
          const missing = [];
          if (!(await endpointReal(from, live, board.zones, sharedRoot))) missing.push(o.from);
          if (!(await endpointReal(to, live, board.zones, sharedRoot))) missing.push(o.to);
          if (missing.length) {
            fail(`端点不在板上也不是存在的工作区路径：${missing.join(' / ')}。read_board 看一眼现在都有谁。`);
            continue;
          }
          const id = `b:a${stamp()}`;
          const tag = o.tag || defaultTag || live[from]?.tag || live[to]?.tag || null;
          const binding = { type: o.type || 'link', from, to, by, ...(o.material && o.material !== 'ink' ? { material: o.material } : {}), ...(o.label ? { label: o.label } : {}), ...(tag ? { tag } : {}) };
          bindings[id] = binding; liveBindings[id] = binding;
          report.push(`+ edge ${id}`); ok += 1;
        } else if (o.op === 'set_edge') {
          const b = liveBindings[o.id];
          if (!b) { fail(`线 ${o.id} 不存在`); continue; }
          const nb = { ...b };
          if (o.label !== undefined) { if (o.label) nb.label = o.label; else delete nb.label; }
          if (o.type) nb.type = o.type;
          if (o.material) { if (o.material === 'ink') delete nb.material; else nb.material = o.material; }
          // 改端点（08-25 RP 案：「状态锚在这一章」每章 remove+add 两次 → 一条命令重指）
          let bad = null;
          for (const end of ['from', 'to']) {
            if (o[end] === undefined) continue;
            const nid = rid(o[end]) || normalizeCanvasId(o[end]);
            if (!nid || !(await endpointReal(nid, live, board.zones, sharedRoot))) { bad = o[end]; break; }
            nb[end] = nid;
          }
          if (bad) { fail(`新端点不在板上也不是存在的路径：${bad}`); continue; }
          if (nb.from === nb.to) { fail('改完两端相同（自环）'); continue; }
          bindings[o.id] = nb; liveBindings[o.id] = nb; ok += 1;
        } else if (o.op === 'remove_edge') {
          if (!liveBindings[o.id]) { fail(`线 ${o.id} 不存在`); continue; }
          bindings[o.id] = null; delete liveBindings[o.id]; ok += 1;
        } else if (o.op === 'reflow') {
          const members = Object.entries(live).filter(([, e]) => e.tag === o.tag && Number.isFinite(e?.x) && e.kind !== 'scribble');
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const horizontal = o.layout === 'row';
          const sorted = members.map(([id, e]) => ({ id, e, r: rectOf(id) }))
            .sort((a, b) => (horizontal ? a.r.x - b.r.x || a.r.y - b.r.y : a.r.y - b.r.y || a.r.x - b.r.x));
          // 08-28 放开：user 座也进重排 —— 调 reflow 本来就是明确的"求结构"，
          // 排序按现位置来，用户挑的**顺序**天然保留（他拖到中间的还在中间）。如实报件数。
          const userSeated = sorted.filter(m => m.e.seat === 'user').map(m => m.id);
          const left = Math.min(...sorted.map(m => m.r.x));
          const top = Math.min(...sorted.map(m => m.r.y));
          let cur = horizontal ? left : top;
          for (const m of sorted) {
            const nx = horizontal ? cur : left;
            const ny = horizontal ? top : cur;
            if (nx !== m.e.x || ny !== m.e.y) {
              setObj(m.id, { ...m.e, x: Math.round(nx), y: Math.round(ny) });
              // 圈着这个节点的记号跟着走 —— reflow 之前的病：文字重排、圈留在原地
              moveHuggers(m.id, Math.round(nx) - m.e.x, Math.round(ny) - m.e.y);
            }
            cur += (horizontal ? m.r.w : m.r.h) + 16;
          }
          if (userSeated.length) report.push(`· #${i + 1} reflow: 含用户拖过的 ${userSeated.length} 件（顺序按他摆的保留）`);
          ok += 1;
        } else if (o.op === 'follow') {
          const members = Object.entries(live).filter(([, e]) => e.tag === o.group_tag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.group_tag} 的东西`); continue; }
          const targets = Object.entries(live).filter(([, e]) => e.tag === o.target_tag && Number.isFinite(e?.x));
          if (!targets.length) { fail(`目标 tag #${o.target_tag} 板上还没有东西`); continue; }
          const from = members.sort((a, b) => a[1].y - b[1].y)[0][0];   // 组里最上面那件当代表
          const to = targets.sort((a, b) => (a[1].y + (a[1].h || 0)) - (b[1].y + (b[1].h || 0))).pop()[0];   // 最下面 = 最新
          if (from === to) { fail('组代表和目标是同一件（group_tag/target_tag 传反了？）'); continue; }
          const existing = Object.entries(liveBindings).find(([, b]) => b.follow === o.target_tag && live[b.from]?.tag === o.group_tag);
          const id = existing ? existing[0] : `b:a${stamp()}`;
          const binding = { type: 'annotates', from, to, by, label: o.label || '跟随', follow: o.target_tag, ...(o.side ? { followSide: o.side } : {}) };
          bindings[id] = binding; liveBindings[id] = binding; ok += 1;
          // 立规则的同时把组摆到目标旁边：之后的跟随是**平移**（保留相对格局），
          // 基线偏移必须在此刻就有意义 —— 不摆的话组停在原地，平移只是搬运一个
          // 无意义的初始偏移（08-25 平移跟随改造时补）
          {
            const r = rectOf(to);
            const memberIds = new Set(members.map(([mid]) => mid));
            const zone = layerOf(to, live[to], known);
            const rects = members.map(([mid]) => rectOf(mid));
            const bb = {
              x: Math.min(...rects.map(x => x.x)), y: Math.min(...rects.map(x => x.y)),
              w: Math.max(...rects.map(x => x.x + x.w)) - Math.min(...rects.map(x => x.x)),
              h: Math.max(...rects.map(x => x.y + x.h)) - Math.min(...rects.map(x => x.y)),
            };
            void zone;
            const pp = placeBeside(r, { w: bb.w, h: bb.h }, o.side || 'right', UNIT);
            const mdx = Math.round(pp.x - bb.x); const mdy = Math.round(pp.y - bb.y);
            if (mdx || mdy) for (const [mid, me] of members) setObj(mid, { ...me, x: me.x + mdx, y: me.y + mdy, seat: 'agent' });
          }
          report.push(`· follow：#${o.group_tag} 已摆到目标旁并从此跟着 #${o.target_tag} 的最新一件（整组平移，用户摆的相对位置保留）`);
        } else if (o.op === 'unfollow') {
          const hits = Object.entries(liveBindings).filter(([, b]) => b.follow && live[b.from]?.tag === o.group_tag);
          if (!hits.length) { fail(`#${o.group_tag} 没有跟随线`); continue; }
          for (const [id] of hits) { bindings[id] = null; delete liveBindings[id]; }
          ok += 1;
        } else if (o.op === 'commit') {
          const { committed: n } = await commitStaging(projectId, { tag: o.tag || null });
          committed += n; ok += 1;
          report.push(`· commit：落定 ${n} 件`);
        } else if (o.op === 'erase_group') {
          const { removed } = await removeByTag(projectId, o.tag);
          erased += removed; ok += 1;
          for (const id of Object.keys(live)) if (live[id]?.tag === o.tag && live[id]?.kind) delete live[id];
          report.push(`· erase_group #${o.tag}：擦掉 ${removed} 件`);
        } else if (o.op === 'roll') {
          // 收卷（2026-08-27 收纳器）：只立状态位，成员座位一件不动 —— 前端把这组
          // 藏进一张卷卡，展开即归位。视觉/渲染/read_board 三头减负，地皮照旧占着
          //（落位引擎仍把它们当障碍，所以永远不会有新东西压进卷里）。
          const members = Object.entries(live).filter(([, e]) => e?.tag === o.tag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.tag} 的东西，没得收`); continue; }
          if (board.rolls?.[o.tag] && !rolls[o.tag]) {
            report.push(`· #${i + 1} roll：#${o.tag} 本来就收着（${members.length} 件）`); ok += 1; continue;
          }
          rolls[o.tag] = { at: new Date().toISOString(), by, ...(o.label ? { label: o.label } : {}) };
          report.push(`· #${i + 1} roll：#${o.tag} 收进卷里（${members.length} 件，座位和文件都在，卷卡单击可展开）`);
          ok += 1;
        } else if (o.op === 'unroll') {
          if (!board.rolls?.[o.tag] && rolls[o.tag] === undefined) { fail(`#${o.tag} 没收着`); continue; }
          rolls[o.tag] = null;
          report.push(`· #${i + 1} unroll：#${o.tag} 展开，全部归位`);
          ok += 1;
        } else if (o.op === 'feature') {
          const id = rid(o.id) || normalizeCanvasId(o.id);
          if (!id) { fail(`${o.id} 不合法`); continue; }
          heroPatch = id; ok += 1;
        } else if (o.op === 'unfeature') {
          heroPatch = null; ok += 1;
        } else if (o.op === 'chalk_edit') {
          // 改板书开关（08-25 用户提：黑板 RP 这类板书密集会话该由 agent 帮忙打开）。
          // 存 ui-config（重开页面还在），并广播给开着的前端当场生效。
          const cfg = (await readUiConfigFile(sharedRoot)) || {};
          await writeUiConfig(sharedRoot, { ...cfg, chalk_edit: !!o.on });
          try { ctx?.emit?.({ type: 'ui.chalk_edit', sessionId: null, on: !!o.on }); } catch { /* */ }
          report.push(`· 改板书开关 → ${o.on ? '开（用户现在可直接拖动/编辑板书）' : '关'}`);
          ok += 1;
        }
      } catch (e) { fail(String(e?.message || e).slice(0, 120)); }
    }
    if (!ok) return err(`没有一条操作成功：\n${report.join('\n')}`);
    if (Object.keys(objects).length || Object.keys(bindings).length || Object.keys(rolls).length || heroPatch !== undefined) {
      await patchBoard(projectId, {
        objects, bindings,
        ...(Object.keys(rolls).length ? { rolls } : {}),
        ...(heroPatch !== undefined ? { hero: heroPatch } : {}),
      });
    }
    // 软删进 .nd/trash/（08-25：删掉的板书要捞得回来，别裸 unlink）
    for (const abs of chalkUnlinks) await trashChalkFile(sharedRoot, abs);
    try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `改了黑板（${ok} 处）` }); } catch { /* */ }
    return { content: [{ type: 'text', text: `Applied ${ok}/${ops.length} op(s).${report.length ? `\n${report.join('\n')}` : ''}` }] };
  };
}
