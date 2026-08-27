/**
 * mcp/tools/write-on-board.js —— write_on_board 统一入口（2026-08-25 范式重做②）
 *
 * 总纲（站主拍板）：**一条板书 = 单节点图，是统一模型的退化情形。** 写字入口只有
 * 这一个；本体选什么不由 agent 选、不由入口分，由一条服务端判据自动定 ——
 * **这一次落板的件数（nodes + shapes 合计；text 简写 = 1 件）**：
 *
 *   件数 = 1（一句话）           件数 ≥ 2（一张图）
 *   本体   notes/板书/*.md 真文件   画布原生 text:/scribble: + data.lid
 *   tag    不打（可显式传并组）      必有，缺省自动 sk-<stamp>
 *   staging false                  true（finish 或回合末落定）
 *   near 线 annotates/flow（relation） 不自动画（要线就写 edges）
 *
 * 验收判据：写一条板书过去填 {text, near} 两个字段，统一后还是两个。
 * 落位全走 lib/board-place.js 的 resolvePlacement（reply_to > at > near+side >
 * 视口 > 内容底下；没有失败分支）；返回文案由 describePlacement 从真实 resolution
 * 生成 —— 08-25 体检陷阱之③「工具返回在撒谎」在这里断根。
 *
 * 旧名 sketch_on_board 注册成薄别名（同参数同 handler），防老会话 resume 断粮。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf } from '../actor.js';
import { z } from 'zod';
import { readBoard, patchBoard, TEXT_FONTS } from '../../../projects/board-store.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { UNIT, SKETCH_FIT, SKETCH_MAX, textBox, shapePath, layoutNodes, resolveTemplate, bboxOf, fitFor } from '../../../lib/sketch-layout.js';
import { resolvePlacement, describePlacement, inflateSpriteSeats, inferFlowDir } from '../../../lib/board-place.js';
import { allocateLaneColumn } from '../../../lib/board-lanes.js';
import { buildSketchShapes, SKETCH_COLORS as COLORS } from '../../../lib/sketch-shapes.js';
import { makeAnchorResolver } from '../../../lib/board-anchor.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { renderChalk, chalkFileName, writeChalkFile, CHALK_DIR } from '../../../lib/chalk.js';
import { ROLE_SLUG_RE } from '../../agent/cast.js';
import { getScene } from '../../agent/scene.js';
import { roundsTableHint } from '../../agent/rounds-table.js';
import { seatArtifacts } from '../../runs/board-seater.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { Events } from '../../agent/events.js';

// 08-25 用户拍板「移除画板上限」：容量类上限全放大成失控兜底，可读性走软提醒。
// zod 硬拒（-32602 整调用作废）是最贵的失败模式 —— 别再用它管风格。
const MAX_NODES = 200;
const MAX_SHAPES = 120;
const MAX_EDGES = 400;

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;
// 墨色表真身在 lib/sketch-shapes.js（棘轮拆件时一起搬 —— 一份表两处读会分叉）

const LOCAL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/, 'local id: letters/digits/_/-');
const GRID_PT = z.object({ x: z.number().min(-2000).max(2000), y: z.number().min(-2000).max(2000) });
const WORLD_PT = z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6) });
// TAG_RE 08-27 收敛：真身在 board-sanitize（落盘闸），zod 入参用同一份 —— 两处等价异写的病根拔掉

/** md 侦测：正文带 markdown 记号却标 plain 会把 **加粗** 原样吐出来（ldx 案） */
const looksLikeMd = (t) => /(\*\*|__|^#{1,4}\s|^\s*[-*]\s|\|.+\||```|\$[^$]+\$|\[.+\]\(.+\))/m.test(t);

const SCHEMA = {
  text: z.string().min(1).max(8000).optional()
    .describe('The one-note shorthand: a short Markdown note (= a 1-piece board write). Give text OR nodes/shapes, not both'),
  near: z.string().max(300).optional()
    .describe('Canvas id or #tag this lands beside (annotates line for a single note)'),
  reply_to: z.string().max(300).optional().describe(`Thread: path of a board note (${CHALK_DIR}/…md) to answer under`),
  at: WORLD_PT.optional()
    .describe('World-coord suggestion. The server always snaps/nudges to a free cell; far outside the working area it is politely rejected and the note lands near instead — placement never fails'),
  side: z.enum(['right', 'left', 'above', 'below']).optional().describe('Which side of near to prefer. Omit for auto: the server picks the side with free space, clear connector lines, and the direction the user has been arranging things — give side only when the SEMANTICS demand it (e.g. a caption must sit above)'),
  relation: z.enum(BINDING_TYPE_IDS).optional()
    .describe('Line type for the near line of a single note (default annotates; flow reads anchor→note)'),
  chain: z.boolean().optional()
    .describe('Single note: auto reply_to the latest board note of the same tag WRITTEN BY YOU (threads never cross authors — continuation rights)'),
  open_lane: z.string().max(300).optional()
    .describe("Open a NEW thread column named by tag and land this note at its head. Value: a canvas id/#tag to BRANCH from (draws a flow line from it), or 'fresh' for a brand-new topic column at the right edge of the map. Requires tag; continue the lane later with {tag, chain:true}. read_board's 版图 section lists existing lanes."),
  tag: z.string().regex(TAG_RE).optional()
    .describe('Group tag. A 1-piece write stays untagged unless you pass one; ≥2 pieces auto-tag sk-<stamp>'),
  ink: z.enum(['chalk', 'hand']).optional()
    .describe("Single note body: 'chalk' (default) = a real file under notes/板书 (Read/Edit later; chain/reply threads live on these); 'hand' = canvas-native handwritten text — a light remark like the user's own handwriting, no file, no threading"),
  font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional().describe("Single note font (ink:'hand'; default kai)"),
  color: z.enum(['ink', 'red', 'pencil', 'brass']).optional().describe("Single note color (ink:'hand')"),
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe("Single note text size. Real for ink:'hand'; for chalk notes it only sizes the placement box (chalk renders at a fixed size)"),
  width: z.number().min(8).max(60).optional().describe('Single note width in grid units (24px); default by content'),
  title: z.string().max(60).optional().describe('Sketch: optional heading written at the top'),
  layout: z.enum(['auto', 'free', 'column', 'row', 'grid', 'mindmap', 'flow']).optional()
    .describe('Sketch layout. auto FOLLOWS YOUR EDGES: with edges it lays out in flow layers (roots on top, children below — give edges and placement is structure); mindmap picks the hub by degree. free needs at on EVERY node'),
  cols: z.number().int().min(1).max(8).optional().describe('grid columns'),
  staging: z.boolean().optional().describe('Sketch only: default true (translucent until commit/turn end). Ignored for single notes — they always land solid'),
  nodes: z.array(z.object({
    id: LOCAL_ID.describe('Local id to reference from edges/shapes'),
    text: z.string().min(1).max(8000),
    format: z.enum(['plain', 'md']).optional().describe('Default: md when the text carries markdown marks, else plain'),
    size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
    font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(),
    color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
    at: GRID_PT.optional().describe('Grid position (layout free); top-left of the node'),
    w: z.number().min(3).max(120).optional().describe('Width in grid units (prefer ≤22 = 528px: paragraphs read better growing down than wide)'),
  })).max(MAX_NODES).optional(),
  shapes: z.array(z.object({
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
  })).max(MAX_SHAPES).optional(),
  edges: z.array(z.object({
    from: z.string().min(1).max(300).describe('local node id or canvas id'),
    to: z.string().min(1).max(300).describe('local node id or canvas id'),
    type: z.enum(BINDING_TYPE_IDS).optional().describe('default link'),
    material: z.enum(BINDING_MATERIALS).optional().describe('default pencil'),
    label: z.string().max(60).optional(),
  })).max(MAX_EDGES).optional(),
};

const DESCRIPTION = `Write on the board — the ONE way to put words and pictures on the canvas.
The board is the conversation; the sidebar is the log.

One thought = one call. What you pass decides what lands:
- {text, near} → a single Markdown note beside the thing it is about, with an
  annotates line. It is a real file (${CHALK_DIR}/…md) you can Read/Grep/Edit later.
  reply_to = thread under another note (flow line); chain:true = auto-thread onto the
  latest note of the same tag. relation/side pick the line type and the side.
- {nodes, shapes, edges, …} → a whole sketch in one call (comparison table, flow,
  mind map, detective board linking real artifacts). You describe STRUCTURE on a grid
  (1 cell = ${UNIT}px); the server does pixels, hand-drawn shapes, and placement. The
  sketch gets a #tag (read/select/erase as a group) and lands as STAGING (translucent)
  until edit_board commits it or the turn ends.
Threads are LANES: a tag names a line of thought growing downward. Continue one with
{tag, chain:true}; fork a new direction off any note with {tag:"新名", open_lane:"<that id>"}
(the column is allocated for you, a flow line marks the fork); a brand-new topic is
{tag:"名", open_lane:"fresh"}. read_board's 版图 section is the map — read it, then place
by RELATION, not by coordinates.
- at:{x,y} (either mode) is a world-coord suggestion: the server snaps to a free cell
  nearby; placement never fails — if your spot is unusable it lands somewhere sensible
  and the return says exactly where and why.
Node text carrying markdown marks defaults to format md (KaTeX $…$ and \`\`\`mermaid fences work).
Readability: user reads at 80–100% zoom — body text md/lg; one sketch ≤ ${SKETCH_FIT.w}x${SKETCH_FIT.h}
world px (bigger lands with a warning — split big ones, link with an edge).
To change what is already on the board use edit_board — do not redraw.
Keep the chat reply to one line pointing here.`;

export function makeWriteOnBoardTool({ projectId, sharedRoot, sessionId, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, sessionId, ctx });
  return tool('write_on_board', DESCRIPTION, SCHEMA, handler);
}

/** 旧名薄别名（一版）：老会话 resume 时还找得到 sketch_on_board */
export function makeSketchOnBoardAlias({ projectId, sharedRoot, sessionId, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, sessionId, ctx });
  return tool('sketch_on_board',
    'Deprecated alias of write_on_board (same arguments). Use write_on_board.',
    SCHEMA, handler);
}

function makeHandler({ projectId, sharedRoot, sessionId, ctx }) {
  return async function handler(args, extra) {
    // 署名：主 agent → 'agent'，常驻角色 → 它的 slug。权威是 harness 在派发时盖的章
    // （agent/actor-trail.js），不是角色文件里的自称 —— 那份文件模型能改。
    const by = byOf(extra);
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (!projectId || !sharedRoot) return err('No project bound.');

    const nodesIn = args.nodes || [];
    const shapesIn = args.shapes || [];
    const edgesIn = args.edges || [];
    const hasSketch = nodesIn.length || shapesIn.length;
    if (args.text && hasSketch) {
      return err('text 是"单节点图"的简写，跟 nodes/shapes 二选一：一句话给 text，一张图把它写成一个 node。');
    }
    if (!args.text && !hasSketch) {
      return err('空手不上板：给 text（一句话）或 nodes/shapes（一张图）。只想画线用 edit_board 的 add_edge。');
    }
    // 单节点图 = 一句话（统一模型的退化情形）：转文件本体那条路，语义字段全保
    if (!args.text && !args.title && nodesIn.length === 1 && !shapesIn.length && !edgesIn.length) {
      const n = nodesIn[0];
      // ⚠️ extra 必须往下传：署名是从 extra 里的 toolUseId 查回来的，
      // 这条自递归漏了它的话，角色用 `nodes:[一件]` 写的板会静默署成 'agent'。
      return handler({
        text: n.text, near: args.near, reply_to: args.reply_to, at: args.at, side: args.side,
        relation: args.relation, chain: args.chain, tag: args.tag, size: n.size, width: n.w,
      }, extra);
    }

    const board = await readBoard(projectId);
    const known = new Set(Object.keys(board.zones || {}));
    // 精灵身位：角色最新一条板书旁贴着它的精灵（客户端摆），落位给那圈让空
    const obstaclesOf = (b, zone) => inflateSpriteSeats(Object.entries(b.objects || {})
      .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === zone)
      .map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(b, id, e) })), b.objects);
    const contentBottomOf = (obstacles, zone) => {
      let bottom = 0;
      for (const o of obstacles) bottom = Math.max(bottom, o.y + o.h);
      if (!zone) for (const zz of Object.values(board.zones || {})) if (Number.isFinite(zz?.y)) bottom = Math.max(bottom, zz.y + 240);
      return bottom;
    };
    const vp = getViewpoint(projectId);
    const fit = fitFor(vp);
    const vpRectFor = (zone) => (vp && (vp.layer || '') === (zone || '') && vp.camera) ? vp.camera : null;
    const visibleIn = (rect, vpRect) => !!vpRect && !(rect.x + rect.w < vpRect.x || vpRect.x + vpRect.w < rect.x
      || rect.y + rect.h < vpRect.y || vpRect.y + vpRect.h < rect.y);

    // 锚点解析（真 id > tag 包络 > 救援入座）本体在 lib/board-anchor.js（棘轮拆件）
    const resolveAnchor = makeAnchorResolver({ projectId, known, readBoard, seatArtifacts });

    // ───────────────────────── 件数 = 1：板书（文件本体） ─────────────────────────
    if (args.text) {
      const body = String(args.text).trim();
      if (!body) return err('空话不上板。');
      // 手写字（ink:'hand'，08-27 收编 create_on_board）：线程语义长在板书文件上
      if (args.ink === 'hand' && (args.chain || args.open_lane || args.reply_to)) {
        return err("ink:'hand' 是画布手写字（无文件本体），接不进线程 —— 要 chain/open_lane/reply_to 就用默认的 chalk。");
      }
      // ── 开新线（open_lane，2026-08-27 空间规划）：模型声明拓扑，机器排列 ──
      if (args.open_lane) {
        if (!args.tag) return err('open_lane 要配 tag：tag 就是这条线的名字，后续用 {tag, chain:true} 续。');
        if (args.reply_to || args.chain || args.at || args.near) {
          return err('open_lane 是开新线，跟 reply_to/chain/at/near 互斥 —— 岔出点直接写在 open_lane 里。');
        }
        if (board.lanes?.[args.tag]) {
          return err(`线 #${args.tag} 已经开过了（read_board 的版图一节看得到）。接着写用 {tag:"${args.tag}", chain:true}；真要另起炉灶，换个名字。`);
        }
      }
      // chain：接在同 tag 最新一条**自己写的**板书后面（chapter 线程不再手抄路径）。
      // 接续权（2026-08-27 编排）：chain 是「续写我的线程」，永远不跨作者 ——
      // GM 的章节线和每个角色的叙事线各自延各自的，中间插了别人的话也不串线。
      let replyToRaw = args.reply_to || null;
      if (!replyToRaw && args.chain) {
        const chalks = Object.entries(board.objects)
          .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x)
            && (!args.tag || e.tag === args.tag) && (e.by || 'agent') === by)
          .map(([id]) => id).sort();
        if (chalks.length) replyToRaw = chalks[chalks.length - 1];
      }
      // rounds 桌（2026-08-27 四模式版式）：轮次模式下角色没给任何落位时，机器按
      // 桌位排 —— 自己的列往下续、首次开口在前一列右边开新列。角色明确给了
      // reply_to/near/at（比如回用户落痕那条）时它的手优先，机器不抢。
      let nearRaw = args.near || null;
      let tableSide = null;
      if (args.ink !== 'hand' && !replyToRaw && !nearRaw && !args.at && !args.open_lane) {
        const t = roundsTableHint(getScene(projectId), board, by);
        if (t?.stack) replyToRaw = t.stack;
        else if (t?.newColumnRightOf) { nearRaw = t.newColumnRightOf; tableSide = 'right'; }
      }

      const em = (l) => [...l].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.62), 0);
      const longest = Math.max(...body.split('\n').map(em));
      const wUnits = args.width || (longest <= 12 ? null : Math.max(12, Math.min(18, Math.ceil(longest * 16 / 24) + 1)));
      const box = textBox(body, args.size === 'sm' ? 'md' : (args.size || 'md'), { md: true, wUnits });

      let zone = '';
      let anchorId = null; let parentId = null;
      let replyRect = null; let anchorRect = null;
      let b2 = board;   // 救援入座后换新板（新座要进障碍集）
      // 开新线：岔出点解析（fresh = 无岔出点，从版图右缘开列）
      let laneFrom = null;   // {id, rect} | 'fresh'
      if (args.open_lane) {
        if (args.open_lane === 'fresh') {
          laneFrom = 'fresh';
        } else {
          const a = await resolveAnchor(args.open_lane, board);
          if (!a) {
            return err(`open_lane 的岔出点 ${args.open_lane} 不在板上（read_board 看一眼现在都有谁）。全新话题用 open_lane:'fresh'。`);
          }
          laneFrom = { id: a.anchorId, rect: a.rect };
          zone = a.zone; if (a.board) b2 = a.board;
          // 分支线：岔出点 → 新线头（flow 读序），跟 near 的画线机制共用
          anchorId = a.anchorId; anchorRect = a.rect;
        }
      }
      if (replyToRaw) {
        const pid2 = normalizeCanvasId(replyToRaw);
        const e = pid2 ? board.objects?.[pid2] : null;
        if (!e || !Number.isFinite(e.x)) return err(`reply_to ${replyToRaw} 不在板上（read_board 里看不到就接不上）。`);
        // 接续权（2026-08-27 编排）：角色的话头只有它自己和用户能接。主控接上去
        // 就是代笔/插嘴的物理形态 —— 这条按板上对象的**作者**判，不看内容不看场。
        // 角色之间可以互接（那就是对话），角色接主控的旁白也行。
        if (by === 'agent' && typeof e.by === 'string' && ROLE_SLUG_RE.test(e.by)) {
          return err(`这条是「${e.by}」的话，你不接在它下面。想让它接着说：把 cue 寄给它`
            + `（SendMessage）或让用户直接跟它说；你自己的旁白/场记另起一条（near 指过去就行）。`);
        }
        parentId = pid2; zone = layerOf(pid2, e, known);
        replyRect = { x: e.x, y: e.y, ...estimateSizeOn(board, pid2, e) };
      }
      if (nearRaw) {
        const a = await resolveAnchor(nearRaw, board);
        if (!a && !parentId && !args.at) {
          return err(`锚点 ${nearRaw} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件（read_board 看一眼现在都有谁）。`);
        }
        if (a) { anchorId = a.anchorId; anchorRect = a.rect; if (!parentId) zone = a.zone; if (a.board) b2 = a.board; }
      }

      const obstacles = obstaclesOf(b2, zone);
      const vpRect = vpRectFor(zone);
      // 开新线走列分配（撞不上姊妹线；没有失败分支），其余走统一落位
      const lanePlan = laneFrom
        ? allocateLaneColumn({
          parent: laneFrom === 'fresh' ? null : laneFrom.rect,
          lanes: Object.values(b2.lanes || {}), obstacles, box,
        })
        : null;
      // 落位直觉（08-27）：接楼方向和自动挑侧都先问用户把这条线往哪边摆过
      const flowDir = inferFlowDir(b2, { tag: args.tag || null });
      // 同时有线程和锚点时，落位跟线程走、但到锚点的线也别压第三块
      const lineTargets = (replyRect && anchorRect)
        ? [{ x: anchorRect.x + anchorRect.w / 2, y: anchorRect.y + anchorRect.h / 2 }]
        : [];
      const placed = lanePlan
        ? { x: lanePlan.x, y: lanePlan.y, resolution: lanePlan.fallback ? 'fallback' : 'lane-open', nudged: !!lanePlan.fallback }
        : resolvePlacement({
          box, replyTo: replyRect, at: args.at || null, anchor: anchorRect, side: args.side || tableSide || null,
          replyDir: flowDir, sideHint: flowDir, lineTargets,
          obstacles, contentBottom: contentBottomOf(obstacles, zone), viewport: vpRect, screen: fit.screen ? fit : null,
        });
      const learnedDir = !lanePlan && flowDir && !args.side && (replyRect || anchorRect) ? flowDir : null;

      // ── 手写字本体（ink:'hand'）：画布原生 text 节点，不落文件 ──
      if (args.ink === 'hand') {
        const hid = `text:a${stamp()}`;
        const data = {
          t: body, ...(looksLikeMd(body) ? { format: 'md' } : {}),
          font: TEXT_FONTS.includes(args.font) ? args.font : 'kai',
          size: args.size || 'md', ...(COLORS.includes(args.color) ? { color: args.color } : {}),
        };
        const hObjects = { [hid]: {
          x: Math.round(placed.x), y: Math.round(placed.y), z: 1, w: box.w, h: box.h,
          kind: 'text', data, zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
        } };
        const hBindings = {};
        if (anchorId) {
          const type = args.relation || 'annotates';
          const [from, to] = type === 'flow' ? [anchorId, hid] : [hid, anchorId];
          hBindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}) };
        }
        await patchBoard(projectId, { objects: hObjects, bindings: hBindings });
        const hRect = { x: Math.round(placed.x), y: Math.round(placed.y), w: box.w, h: box.h };
        try {
          ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: '写了一段手写字' });
          ctx?.emit?.(Events.boardFocus(hRect, { tag: args.tag || null, layer: zone, soft: true, actor: by !== 'agent' ? by : null }));
        } catch { /* fail-soft */ }
        return { content: [{ type: 'text', text:
          `Wrote handwritten note ${hid} at (${hRect.x},${hRect.y}) ${hRect.w}x${hRect.h} — ${describePlacement(placed, { requestedAt: args.at })}.`
          + (learnedDir ? ` Layout followed the user's ${learnedDir}-ward arranging habit.` : '') }] };
      }

      const fileName = chalkFileName(body);
      const content = renderChalk({ body, by, anchor: anchorId, replyTo: parentId, tag: args.tag || null, sessionId: sessionId || null });
      const rel = await writeChalkFile(sharedRoot, fileName, content);

      const objects = { [rel]: {
        x: Math.round(placed.x), y: Math.round(placed.y), z: 1, w: box.w, h: box.h,
        zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
      } };
      const bindings = {};
      if (anchorId) {
        const type = args.relation || (lanePlan ? 'flow' : 'annotates');
        // flow 是读序（旧 → 新）：锚在前板书在后；其余语义都是"这条说的是它"
        const [from, to] = type === 'flow' ? [anchorId, rel] : [rel, anchorId];
        bindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}) };
      }
      if (parentId) bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: rel, by, material: 'pencil', ...(args.tag ? { tag: args.tag } : {}) };
      await patchBoard(projectId, {
        objects, bindings,
        ...(lanePlan ? { lanes: { [args.tag]: {
          x: Math.round(placed.x), y: Math.round(placed.y), w: lanePlan.w,
          ...(laneFrom !== 'fresh' && laneFrom?.id ? { parent: laneFrom.id } : {}),
        } } } : {}),
      });
      // 跟随线：这个 tag 有人跟着（状态板之类）就自动重锚挪组（fail-soft）
      if (args.tag) { try { await applyFollows(projectId, { tag: args.tag, newId: rel }); } catch { /* */ } }

      const rect = { x: Math.round(placed.x), y: Math.round(placed.y), w: box.w, h: box.h };
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: parentId ? '回了一条板书' : '写了一条板书' });
        ctx?.emit?.(Events.boardFocus(rect, { tag: args.tag || null, layer: zone, soft: true, chalk: rel, actor: by !== 'agent' ? by : null }));
      } catch { /* fail-soft */ }
      const lines = [
        `Wrote board note ${rel} at (${rect.x},${rect.y}) ${rect.w}x${rect.h} — ${describePlacement(placed, { requestedAt: args.at })}.`,
        `Visible in the user's viewport: ${visibleIn(rect, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
      ];
      if (box.h > SKETCH_FIT.h * 0.6) lines.push('⚠ It is tall — next time split or shorten.');
      if (learnedDir) lines.push(`Layout followed the user's habit: they have been arranging this thread ${learnedDir}-ward, so placement leaned that way.`);
      // 收卷提醒（2026-08-27 收纳器）：落进收着的组 = 用户看不见这条新话
      {
        const rolledInto = [args.tag, board.objects?.[parentId]?.tag, board.objects?.[anchorId]?.tag]
          .find(t => t && b2.rolls?.[t]);
        if (rolledInto) lines.push(`⚠ #${rolledInto} 这条线收着卷（用户看不见里面）——这条也进了卷。要让用户看见，先 edit_board unroll{tag:"${rolledInto}"}。`);
      }
      if (lanePlan) {
        lines.push(`Opened lane #${args.tag}${laneFrom !== 'fresh' ? ` branching from ${laneFrom.id}` : ''}`
          + ` — continue it with {tag:"${args.tag}", chain:true}; read_board lists all lanes under 版图.`);
      }
      lines.push('The user can annotate it to reply; answer with reply_to (or chain:true on the same tag).');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ───────────────────────── 件数 ≥ 2：一张图（画布原生） ─────────────────────────
    // 单个形状（比如一个圈、一条下划线）是"记号"：画布原生，但不强打 tag、不进草稿态
    const soloMark = !args.title && !nodesIn.length && shapesIn.length === 1;
    const tag = args.tag || (soloMark ? null : `sk-${stamp()}`);
    const staging = args.staging !== false && !soloMark;

    const localIds = new Set();
    const nodes = [];
    if (args.title) {
      nodes.push({ key: '__title', text: `## ${args.title}`, format: 'md', size: 'md', font: 'kai', color: 'ink', at: null, w: null });
    }
    for (const n of nodesIn) {
      if (localIds.has(n.id)) return err(`节点 id 重复：${n.id}`);
      localIds.add(n.id);
      const size = (n.size === 'sm' && n.text.length > 40) ? 'md' : (n.size || 'md');
      // 缺省 format 按内容侦测：带 markdown 记号标 plain 会把 **加粗** 吐成星号（ldx 案）
      const format = n.format || (looksLikeMd(n.text) ? 'md' : 'plain');
      nodes.push({ key: n.id, text: n.text, format, size, font: n.font || 'pen', color: n.color || 'ink', at: n.at || null, w: n.w || null });
    }
    for (const n of nodes) {
      const box = textBox(n.text, n.size, { md: n.format === 'md', wUnits: n.w });
      n.w = box.w; n.h = box.h;
    }
    const titleNode = nodes.find(n => n.key === '__title');
    // 图内边（两端都是本图节点）：布局的结构输入 + 零线大图的提醒判据
    const nodeKeys = new Set(nodes.map(n => n.key));
    const innerEdges = edgesIn.filter(e => nodeKeys.has(e.from) && nodeKeys.has(e.to) && e.from !== e.to);
    const tpl = resolveTemplate(nodes.filter(n => n !== titleNode), { template: args.layout || 'auto', edges: innerEdges });
    // 节点级拉力（08-27 产物锚 v2）：节点 ↔ 板上已有产物的边，给布局一个方向 ——
    // 连着谁就排向谁那一侧（flow 层内排序 / mindmap 环位都吃它）
    const pull = new Map();
    for (const e of edgesIn) {
      for (const [self, other] of [[e.from, e.to], [e.to, e.from]]) {
        if (!nodeKeys.has(self) || nodeKeys.has(other)) continue;
        const cid = normalizeCanvasId(other);
        const ext = cid ? board.objects?.[cid] : null;
        if (!ext || !Number.isFinite(ext.x)) continue;
        const s = estimateSizeOn(board, cid, ext);
        const c = { x: ext.x + s.w / 2, y: ext.y + s.h / 2 };
        const cur = pull.get(self);
        pull.set(self, cur ? { x: (cur.x + c.x) / 2, y: (cur.y + c.y) / 2 } : c);
      }
    }
    if (tpl === 'free') {
      // free 的合同：每个节点都要 at。缺 at 静默排成一列是 ldx 那晚两次重画的病根 —— 明拒，报名单。
      const missing = nodes.filter(n => n !== titleNode && !n.at).map(n => n.key);
      if (missing.length) {
        return err(`layout free 要求每个节点都带 at（网格坐标），缺：${missing.join(', ')}。给它们补 at，或者去掉 layout:'free' 用模板排。`);
      }
    }
    const layoutInput = titleNode && tpl === 'mindmap' ? nodes.filter(n => n !== titleNode) : nodes;
    let pos = layoutNodes(layoutInput, { template: tpl, cols: args.cols, edges: innerEdges, pull });
    const seatTitle = () => {
      if (titleNode && !pos.has('__title')) {
        const bb = bboxOf([...pos.entries()].map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
        pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
      } else if (titleNode && tpl === 'free' && !titleNode.at) {
        const bb = bboxOf([...pos.entries()].filter(([k]) => k !== '__title').map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
        pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
      }
    };
    seatTitle();
    const rectOfNode = (key) => { const n = nodes.find(x => x.key === key); const p = pos.get(key); return n && p ? { x: p.x, y: p.y, w: n.w, h: n.h } : null; };

    // ── 形状（局部像素）：构建本体在 lib/sketch-shapes.js（08-27 棘轮拆件） ──
    const built = buildSketchShapes(shapesIn, { rectOfNode, isTaken: (id) => localIds.has(id), tag });
    if (built.error) return err(built.error);
    const shapes = built.shapes;
    // ── 线：先于落位（连到真实产物的线会改主角判断 → 尺寸） ──
    const idOf = new Map();
    for (const n of nodes) idOf.set(n.key, `text:a${stamp()}`);
    for (const sh of shapes) idOf.set(sh.key, `scribble:a${stamp()}`);
    const resolveEnd = (raw) => {
      if (idOf.has(raw)) return idOf.get(raw);
      const cid = normalizeCanvasId(raw);
      if (cid && board.objects?.[cid]) return cid;
      if (cid && board.zones?.[cid] !== undefined) return cid;
      return null;
    };
    const bindings = {};
    const badEdges = [];
    for (const e of edgesIn) {
      const from = resolveEnd(e.from); const to = resolveEnd(e.to);
      if (!from || !to || from === to) { badEdges.push(`${e.from}→${e.to}`); continue; }
      bindings[`b:a${stamp()}`] = {
        type: e.type || 'link', from, to, by, material: e.material || 'pencil',
        ...(tag ? { tag } : {}), ...(staging ? { staging: true } : {}), ...(e.label ? { label: e.label } : {}),
      };
    }
    const after = { ...board, bindings: { ...(board.bindings || {}), ...bindings } };

    // ── 宏观落位（resolvePlacement 统一走） ──
    const local = bboxOf([
      ...nodes.map(n => ({ ...pos.get(n.key), w: n.w, h: n.h })),
      ...shapes.map(sh => sh.rect),
    ]);
    // 巨图不再硬拒（08-25 用户拍板移除上限）：照落，返回里强提醒拆分
    const oversized = local.w > SKETCH_MAX.w || local.h > SKETCH_MAX.h;
    let zone = '';
    let anchorRect = null;
    let sketchBase = board;
    if (args.near) {
      const a = await resolveAnchor(args.near, board);
      if (!a && !args.at) return err(`锚点 ${args.near} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件（read_board 看一眼现在都有谁）。`);
      if (a) {
        zone = a.zone;
        if (a.board) sketchBase = a.board;
        const e = sketchBase.objects[a.anchorId];
        anchorRect = { x: a.rect.x, y: a.rect.y, ...estimateSizeOn(after, a.anchorId, e) };
        if (a.rect.w > anchorRect.w) anchorRect = a.rect;   // tag 包络比单卡大就用包络
      }
    }
    // 产物锚（08-27 用户问「围绕产物做编排」补上的那半边）：图的线连着板上已有的
    // 产物、又没给 near/at 时，图**自动落在被连产物旁边** —— 线说"这张图说的是它们"，
    // 位置就得跟着说；否则线画上了、图却摊在版面尽头，位置和线自相矛盾。
    let autoAnchorIds = [];
    if (!anchorRect && !args.at) {
      const newIds = new Set(idOf.values());
      autoAnchorIds = [...new Set(Object.values(bindings).flatMap((b) => [b.from, b.to])
        .filter((id) => !newIds.has(id) && Number.isFinite(sketchBase.objects?.[id]?.x)))];
      if (autoAnchorIds.length) {
        const rects = autoAnchorIds.map((id) => {
          const e = sketchBase.objects[id];
          return { x: e.x, y: e.y, ...estimateSizeOn(after, id, e) };
        });
        anchorRect = bboxOf(rects);
        zone = layerOf(autoAnchorIds[0], sketchBase.objects[autoAnchorIds[0]], known);
      }
    }
    const afterEff = sketchBase === board ? after : { ...sketchBase, bindings: { ...(sketchBase.bindings || {}), ...bindings } };
    const obstacles = obstaclesOf(afterEff, zone);
    const vpRect = vpRectFor(zone);
    const placed = resolvePlacement({
      box: { w: local.w + 24, h: local.h + 24 },
      at: args.at || null, anchor: anchorRect, side: args.side || null,
      // 落位直觉：side 不给时自动挑（空侧+线不压块），偏好排用户摆放习惯
      sideHint: inferFlowDir(sketchBase, { tag: args.tag || null }),
      obstacles, contentBottom: contentBottomOf(obstacles, zone), viewport: vpRect,
      screen: fit.screen ? fit : null,
    });
    const ox = placed.x - local.x + 12; const oy = placed.y - local.y + 12;
    // mindmap 的方位重排要**真实图心**（落位前算不出，单锚时质心还会退化）——
    // 环形 bbox 不随槽位变，落位定了再按世界方位二次布局，落位本身不漂
    if (tpl === 'mindmap' && pull.size) {
      pos = layoutNodes(layoutInput, { template: 'mindmap', cols: args.cols, edges: innerEdges, pull, pullOrigin: { x: ox, y: oy } });
      seatTitle();
    }

    // ── 落盘 ──
    const objects = {};
    const common = { z: 1, zone, by, seat: 'agent', ...(tag ? { tag } : {}), ...(staging ? { staging: true } : {}) };
    for (const n of nodes) {
      const p = pos.get(n.key);
      objects[idOf.get(n.key)] = {
        x: Math.round(p.x + ox), y: Math.round(p.y + oy), w: n.w, h: n.h, kind: 'text',
        data: { t: n.text, ...(n.format === 'md' ? { format: 'md' } : {}), font: TEXT_FONTS.includes(n.font) ? n.font : 'pen', size: n.size, color: n.color, lid: n.key },
        ...common,
      };
    }
    for (const sh of shapes) {
      objects[idOf.get(sh.key)] = { x: Math.round(sh.rect.x + ox), y: Math.round(sh.rect.y + oy), w: Math.round(sh.rect.w), h: Math.round(sh.rect.h), kind: 'scribble', data: { d: sh.d, color: sh.color, width: sh.width }, ...(sh.hug && idOf.get(sh.hug) ? { hug: idOf.get(sh.hug) } : {}), ...common };
    }
    const saved = await patchBoard(projectId, { objects, bindings });
    const landed = Object.keys(objects).filter(id => saved.objects?.[id]).length;
    if (!landed) return err('草图被 board 拒了（内容或字段不合法）。');
    if (tag && nodes.length) { try { await applyFollows(projectId, { tag, newId: idOf.get(nodes[0].key) }); } catch { /* */ } }
    const world = { x: Math.round(local.x + ox), y: Math.round(local.y + oy), w: Math.round(local.w), h: Math.round(local.h) };
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: tag ? `画了一张草图 #${tag}` : '画了一个记号' });
      ctx?.emit?.(Events.boardFocus(world, { tag: tag || null, layer: zone, actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const lines = [
      `Sketch${tag ? ` #${tag}` : ''} landed${staging ? ' as STAGING (半透明)' : ''}: ${nodes.length} nodes, ${shapes.length} shapes, ${Object.keys(bindings).length} lines; layout ${tpl}; at world (${world.x},${world.y}) ${world.w}x${world.h} — ${describePlacement(placed, { requestedAt: args.at })}.`,
      `ids: ${[...idOf].map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `Visible in the user's viewport: ${visibleIn(world, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
    ];
    if (oversized) lines.push(`⚠ 这张图 ${Math.round(local.w)}x${Math.round(local.h)} 世界像素，远超一屏（建议 ≤${SKETCH_MAX.w}x${SKETCH_MAX.h}）——用户要拖着镜头看。下次拆成几张 tag 图用线连。`);
    // 零线大图提醒（08-27 用户报「草草一堆文字摊在那儿」）：软提醒不硬拒 ——
    // 但要说清楚这不是风格问题，是版面语言缺了一半
    if (nodesIn.length >= 3 && !innerEdges.length) {
      lines.push(`⚠ ${nodesIn.length} 件 0 线 —— 这是摊了一堆字，不是一张图。线是版面的语言：`
        + `补 edges（谁连谁、什么关系，布局会按结构分层摆）；这些如果本是一条思路，`
        + `改走 {tag, chain:true} 让它长成线。`);
    }
    if (badEdges.length) lines.push(`Skipped ${badEdges.length} edge(s) with unknown endpoints: ${badEdges.slice(0, 6).join(', ')}`);
    if (world.w > fit.w || world.h > fit.h) lines.push(`⚠ Bigger than one screen at 80% zoom${fit.screen ? ` (user's screen ${fit.screen.w}x${fit.screen.h}px → ${fit.w}x${fit.h} world px fits)` : ` (${fit.w}x${fit.h} fits)`} — split into two tagged sketches next time.`);
    if (autoAnchorIds.length) {
      lines.push(`（没给 near/at，但这张图的线连着 ${autoAnchorIds.slice(0, 4).join('、')}${autoAnchorIds.length > 4 ? ' 等' : ''} —— 自动落在它们旁边）`);
    }
    if (vp?.zoom && vp.zoom < 0.8) lines.push(`User's zoom is ${vp.zoom} (<0.8): keep nodes md/lg and say in one line that there is a sketch on the board.`);
    lines.push(staging
      ? `Next: look_at_board {tag:"${tag}"} to check it, then finish_sketch {tag:"${tag}"} (or it commits at turn end).`
      : `Next: look_at_board ${tag ? `{tag:"${tag}"}` : '{around: one of the ids}'} to check it.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  };
}
