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
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId, tagEnvelope } from '../../../lib/canvas-id.js';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { UNIT, SKETCH_FIT, SKETCH_MAX, textBox, shapePath, layoutNodes, bboxOf, fitFor } from '../../../lib/sketch-layout.js';
import { resolvePlacement, describePlacement, inflateSpriteSeats } from '../../../lib/board-place.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { renderChalk, chalkFileName, writeChalkFile, CHALK_DIR } from '../../../lib/chalk.js';
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
const COLORS = ['ink', 'red', 'pencil', 'brass'];

const LOCAL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/, 'local id: letters/digits/_/-');
const GRID_PT = z.object({ x: z.number().min(-2000).max(2000), y: z.number().min(-2000).max(2000) });
const WORLD_PT = z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6) });
const TAG_RE = /^[\w一-鿿぀-ヿ-]{1,40}$/;

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
  side: z.enum(['right', 'left', 'above', 'below']).optional().describe('Which side of near to prefer (default right)'),
  relation: z.enum(BINDING_TYPE_IDS).optional()
    .describe('Line type for the near line of a single note (default annotates; flow reads anchor→note)'),
  chain: z.boolean().optional()
    .describe('Single note: auto reply_to the latest board note of the same tag (chapter threads without hand-copying paths)'),
  tag: z.string().regex(TAG_RE).optional()
    .describe('Group tag. A 1-piece write stays untagged unless you pass one; ≥2 pieces auto-tag sk-<stamp>'),
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe('Single note text size (md default, lg headline)'),
  width: z.number().min(8).max(60).optional().describe('Single note width in grid units (24px); default by content'),
  title: z.string().max(60).optional().describe('Sketch: optional heading written at the top'),
  layout: z.enum(['auto', 'free', 'column', 'row', 'grid', 'mindmap']).optional()
    .describe('Sketch layout. free needs at on EVERY node (missing ones are an error, not a silent column)'),
  cols: z.number().int().min(1).max(8).optional().describe('grid columns'),
  staging: z.boolean().optional().describe('Sketch default true (translucent until finish/turn end); single note default false'),
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
    const sizeOf = (b) => (id, e) => estimateSizeOn(b, id, e);
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

    /** 锚点解析：真 id > tag 包络 > **救援入座**（文件真在只是还没座位 —— 当场
     *  给它排一个再锚。入座下沉后防抖 1.5s 内的窗口、以及历史欠座都从这里兜住，
     *  「还没有座位」这个失败类只剩"确实不存在"一种真情况）。 */
    const resolveAnchor = async (raw, b) => {
      const nid = normalizeCanvasId(raw);
      const e = nid ? b.objects?.[nid] : null;
      if (e && Number.isFinite(e.x)) {
        return { anchorId: nid, zone: layerOf(nid, e, known), rect: { x: e.x, y: e.y, ...estimateSizeOn(b, nid, e) }, board: b };
      }
      const env = tagEnvelope(b, raw, sizeOf(b));
      if (env) {
        return { anchorId: env.anchorId, zone: layerOf(env.anchorId, b.objects[env.anchorId], known), rect: { x: env.x, y: env.y, w: env.w, h: env.h }, board: b };
      }
      if (nid) {
        const bare = nid.replace(/^(deck|site|docx|text|scribble):/, '');
        const { seated } = await seatArtifacts(projectId, [bare]).catch(() => ({ seated: 0 }));
        if (seated) {
          const nb = await readBoard(projectId);
          const ne = nb.objects?.[nid] || nb.objects?.[bare];
          const realId = nb.objects?.[nid] ? nid : bare;
          if (ne && Number.isFinite(ne.x)) {
            return { anchorId: realId, zone: layerOf(realId, ne, known), rect: { x: ne.x, y: ne.y, ...estimateSizeOn(nb, realId, ne) }, board: nb, rescued: true };
          }
        }
      }
      return null;
    };

    // ───────────────────────── 件数 = 1：板书（文件本体） ─────────────────────────
    if (args.text) {
      const body = String(args.text).trim();
      if (!body) return err('空话不上板。');
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

      const em = (l) => [...l].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.62), 0);
      const longest = Math.max(...body.split('\n').map(em));
      const wUnits = args.width || (longest <= 12 ? null : Math.max(12, Math.min(18, Math.ceil(longest * 16 / 24) + 1)));
      const box = textBox(body, args.size === 'sm' ? 'md' : (args.size || 'md'), { md: true, wUnits });

      let zone = '';
      let anchorId = null; let parentId = null;
      let replyRect = null; let anchorRect = null;
      let b2 = board;   // 救援入座后换新板（新座要进障碍集）
      if (replyToRaw) {
        const pid2 = normalizeCanvasId(replyToRaw);
        const e = pid2 ? board.objects?.[pid2] : null;
        if (!e || !Number.isFinite(e.x)) return err(`reply_to ${replyToRaw} 不在板上（read_board 里看不到就接不上）。`);
        // 接续权（2026-08-27 编排）：角色的话头只有它自己和用户能接。主控接上去
        // 就是代笔/插嘴的物理形态 —— 这条按板上对象的**作者**判，不看内容不看场。
        // 角色之间可以互接（那就是对话），角色接主控的旁白也行。
        if (by === 'agent' && typeof e.by === 'string' && e.by.startsWith('rp-')) {
          return err(`这条是「${e.by}」的话，你不接在它下面。想让它接着说：把 cue 寄给它`
            + `（SendMessage）或让用户直接跟它说；你自己的旁白/场记另起一条（near 指过去就行）。`);
        }
        parentId = pid2; zone = layerOf(pid2, e, known);
        replyRect = { x: e.x, y: e.y, ...estimateSizeOn(board, pid2, e) };
      }
      if (args.near) {
        const a = await resolveAnchor(args.near, board);
        if (!a && !parentId && !args.at) {
          return err(`锚点 ${args.near} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件（read_board 看一眼现在都有谁）。`);
        }
        if (a) { anchorId = a.anchorId; anchorRect = a.rect; if (!parentId) zone = a.zone; if (a.board) b2 = a.board; }
      }

      const obstacles = obstaclesOf(b2, zone);
      const vpRect = vpRectFor(zone);
      const placed = resolvePlacement({
        box, replyTo: replyRect, at: args.at || null, anchor: anchorRect, side: args.side || null,
        obstacles, contentBottom: contentBottomOf(obstacles, zone), viewport: vpRect, screen: fit.screen ? fit : null,
      });

      const fileName = chalkFileName(body);
      const content = renderChalk({ body, by, anchor: anchorId, replyTo: parentId, tag: args.tag || null, sessionId: sessionId || null });
      const rel = await writeChalkFile(sharedRoot, fileName, content);

      const objects = { [rel]: {
        x: Math.round(placed.x), y: Math.round(placed.y), z: 1, w: box.w, h: box.h,
        zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
      } };
      const bindings = {};
      if (anchorId) {
        const type = args.relation || 'annotates';
        // flow 是读序（旧 → 新）：锚在前板书在后；其余语义都是"这条说的是它"
        const [from, to] = type === 'flow' ? [anchorId, rel] : [rel, anchorId];
        bindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}) };
      }
      if (parentId) bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: rel, by, material: 'pencil', ...(args.tag ? { tag: args.tag } : {}) };
      await patchBoard(projectId, { objects, bindings });
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
    let tpl = args.layout || 'auto';
    if (tpl === 'auto') tpl = nodes.some(n => n.at) ? 'free' : (nodes.length - (titleNode ? 1 : 0) <= 4 ? 'column' : 'grid');
    if (tpl === 'free') {
      // free 的合同：每个节点都要 at。缺 at 静默排成一列是 ldx 那晚两次重画的病根 —— 明拒，报名单。
      const missing = nodes.filter(n => n !== titleNode && !n.at).map(n => n.key);
      if (missing.length) {
        return err(`layout free 要求每个节点都带 at（网格坐标），缺：${missing.join(', ')}。给它们补 at，或者去掉 layout:'free' 用模板排。`);
      }
    }
    const layoutInput = titleNode && tpl === 'mindmap' ? nodes.filter(n => n !== titleNode) : nodes;
    const pos = layoutNodes(layoutInput, { template: tpl, cols: args.cols });
    if (titleNode && !pos.has('__title')) {
      const bb = bboxOf([...pos.entries()].map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
      pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
    } else if (titleNode && tpl === 'free' && !titleNode.at) {
      const bb = bboxOf([...pos.entries()].filter(([k]) => k !== '__title').map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
      pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
    }
    const rectOfNode = (key) => { const n = nodes.find(x => x.key === key); const p = pos.get(key); return n && p ? { x: p.x, y: p.y, w: n.w, h: n.h } : null; };

    // ── 形状（局部像素） ──
    const shapes = [];
    for (let i = 0; i < shapesIn.length; i += 1) {
      const s = shapesIn[i];
      const sid = s.id || `s${i + 1}`;
      if (localIds.has(sid) || shapes.some(x => x.key === sid)) return err(`形状 id「${sid}」跟节点/别的形状重名（形状缺省叫 s1,s2…，节点别用这类名）`);
      const seed = `${tag || 'solo'}:${sid}`;
      const color = COLORS.includes(s.color) ? s.color : (s.kind === 'arrow' || s.kind === 'line' ? 'ink2' : 'ink');
      const width = s.width || 2;
      let rect; let d;
      if (s.kind === 'path') {
        if (!s.d || !/^[\dMLQCZ ,.\-eE]+$/.test(s.d)) return err(`形状 ${sid}：path 只收 M/L/Q/Z 与数字`);
        const nums = s.d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
        const xs = nums.filter((_, k) => k % 2 === 0); const ys = nums.filter((_, k) => k % 2 === 1);
        const w = Math.max(4, Math.max(...xs) - Math.min(0, Math.min(...xs))); const h = Math.max(4, Math.max(...ys) - Math.min(0, Math.min(...ys)));
        rect = { x: (s.at?.x || 0) * UNIT, y: (s.at?.y || 0) * UNIT, w: w + 6, h: h + 6 };
        d = s.d;
      } else if (s.kind === 'line' || s.kind === 'arrow' || s.kind === 'underline') {
        let a; let b;
        if (s.kind === 'underline' && s.around) {
          const r = rectOfNode(s.around); if (!r) return err(`形状 ${sid}：around 指向不存在的节点 ${s.around}`);
          a = { x: r.x + 2, y: r.y + r.h - 2 }; b = { x: r.x + r.w - 2, y: r.y + r.h - 2 };
        } else {
          if (!s.at) return err(`形状 ${sid}：${s.kind} 要 at 起点`);
          a = { x: s.at.x * UNIT, y: s.at.y * UNIT };
          if (s.toNode) {
            const r = rectOfNode(s.toNode); if (!r) return err(`形状 ${sid}：toNode 指向不存在的节点 ${s.toNode}`);
            b = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
          } else if (s.to) b = { x: s.to.x * UNIT, y: s.to.y * UNIT };
          else if (s.kind === 'underline') b = { x: a.x + (s.w || 4) * UNIT, y: a.y };
          else return err(`形状 ${sid}：${s.kind} 要 to 或 toNode`);
        }
        const sp = shapePath(s.kind, { to: { x: b.x - a.x, y: b.y - a.y } }, seed);
        rect = { x: Math.min(a.x, b.x) - 6, y: Math.min(a.y, b.y) - 6, w: sp.w, h: sp.h };
        d = sp.d;
      } else {
        let box;
        if (s.around) {
          const r = rectOfNode(s.around); if (!r) return err(`形状 ${sid}：around 指向不存在的节点 ${s.around}`);
          const pad = s.kind === 'rect' ? 8 : 14;
          box = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
          if (s.kind === 'circle') { const dmax = Math.max(box.w, box.h); box = { x: box.x + (box.w - dmax) / 2, y: box.y + (box.h - dmax) / 2, w: dmax, h: dmax }; }
        } else {
          if (!s.at || !s.w) return err(`形状 ${sid}：${s.kind} 要 at + w（+h）或 around`);
          box = { x: s.at.x * UNIT, y: s.at.y * UNIT, w: s.w * UNIT, h: (s.h || s.w) * UNIT };
        }
        const sp = shapePath(s.kind, { w: box.w, h: box.h }, seed);
        rect = { x: box.x - 6, y: box.y - 6, w: sp.w, h: sp.h };
        d = sp.d;
      }
      shapes.push({ key: sid, rect, d, color: COLORS.includes(color) ? color : 'ink', width });
    }
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
    const afterEff = sketchBase === board ? after : { ...sketchBase, bindings: { ...(sketchBase.bindings || {}), ...bindings } };
    const obstacles = obstaclesOf(afterEff, zone);
    const vpRect = vpRectFor(zone);
    const placed = resolvePlacement({
      box: { w: local.w + 24, h: local.h + 24 },
      at: args.at || null, anchor: anchorRect, side: args.side || null,
      obstacles, contentBottom: contentBottomOf(obstacles, zone), viewport: vpRect,
      screen: fit.screen ? fit : null,
    });
    const ox = placed.x - local.x + 12; const oy = placed.y - local.y + 12;

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
      objects[idOf.get(sh.key)] = { x: Math.round(sh.rect.x + ox), y: Math.round(sh.rect.y + oy), w: Math.round(sh.rect.w), h: Math.round(sh.rect.h), kind: 'scribble', data: { d: sh.d, color: sh.color, width: sh.width }, ...common };
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
    if (badEdges.length) lines.push(`Skipped ${badEdges.length} edge(s) with unknown endpoints: ${badEdges.slice(0, 6).join(', ')}`);
    if (world.w > fit.w || world.h > fit.h) lines.push(`⚠ Bigger than one screen at 80% zoom${fit.screen ? ` (user's screen ${fit.screen.w}x${fit.screen.h}px → ${fit.w}x${fit.h} world px fits)` : ` (${fit.w}x${fit.h} fits)`} — split into two tagged sketches next time.`);
    if (vp?.zoom && vp.zoom < 0.8) lines.push(`User's zoom is ${vp.zoom} (<0.8): keep nodes md/lg and say in one line that there is a sketch on the board.`);
    lines.push(staging
      ? `Next: look_at_board {tag:"${tag}"} to check it, then finish_sketch {tag:"${tag}"} (or it commits at turn end).`
      : `Next: look_at_board ${tag ? `{tag:"${tag}"}` : '{around: one of the ids}'} to check it.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  };
}
