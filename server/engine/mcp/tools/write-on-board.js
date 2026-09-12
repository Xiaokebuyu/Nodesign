/**
 * mcp/tools/write-on-board.js —— write_on_board 统一入口（2026-08-25 范式重做②；
 * 2026-08-29 纸范式；2026-09-05 意图层落位：纸退役，位置只说关系）
 *
 * 总纲（站主拍板）：**一条板书 = 单节点图，是统一模型的退化情形。** 写字入口只有
 * 这一个；本体选什么不由 agent 选、不由入口分，由一条服务端判据自动定 ——
 * **这一次落板的件数（nodes + shapes 合计；text 简写 = 1 件）**：
 *
 *   件数 = 1（一句话）           件数 ≥ 2（一张图）
 *   本体   notes/板书/*.md 真文件   画布原生 text:/scribble: + data.lid
 *   tag    不打（可显式传并组）      必有，缺省自动 sk-<stamp>
 *   staging false                  true（finish 或回合末落定）
 *
 * ## 落位 = 关系（2026-09-05）
 *
 * 纸范式退役（理由与数据见 lib/board-place.js 头注）。agent 只说关系：
 *   - reply_to / chain = 接楼：正下方，被挡就跳到挡它的东西底下，没有底
 *   - place.with       = 续同一组：组尾正下方
 *   - place.by / near  = 贴着锚；place.side 是偏好，放不下换侧、滑开、螺旋找最近空位
 *   - 什么都不给       = 用户视口里的空地；没有视口就排在内容底下
 * 像素由 lib/board-place.js 解，永远不拒收；框由内容撑开，卡高封顶折叠如实报。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf, toolUseIdOf } from '../actor.js';
import { readBoard, patchBoard, TEXT_FONTS } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { endpointReal } from './edit-board.js';
import { BINDING_TYPE_IDS } from '../../../lib/binding-types.js';
import { UNIT, SKETCH_MAX, textBox, layoutNodes, resolveTemplate, bboxOrZero, fitFor } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { overlapIds } from '../../../lib/board-place.js';
import { heroAfterLine, heroSize } from '../../../lib/board-hero.js';
import { makeChalkEnv, resolveChalkSpot } from './write-on-board-resolve.js';
import { reserveSpot, updateReservation, getReservation, takeReservation } from '../../../lib/board-reservations.js';
import { buildSketchShapes, SKETCH_COLORS as COLORS } from '../../../lib/sketch-shapes.js';
import { makeAnchorResolver, anchorMissHint } from '../../../lib/board-anchor.js';
import { lineCrossings } from '../../../lib/line-route.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { renderChalk, chalkFileName, writeChalkFile, CHALK_DIR } from '../../../lib/chalk.js';
import { STATE_TABLE_TAG, parseStateTable } from '../../../lib/state-table.js';
import { maybeFlowWrite } from './write-on-board-flow.js';
import { ROLE_SLUG_RE } from '../../agent/cast.js';
import { WRITE_SCHEMA as SCHEMA, WIDTH_UNITS } from './write-on-board-schema.js';
import { roleDefaultAnchor } from './write-on-board-role-anchor.js';
import { seatArtifacts } from '../../runs/board-seater.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { Events } from '../../agent/events.js';
import { learnedChalkWidth } from '../../../lib/chalk-size-pref.js';

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

/** md 侦测：正文带 markdown 记号却标 plain 会把 **加粗** 原样吐出来（ldx 案） */
const looksLikeMd = (t) => /(\*\*|__|^#{1,4}\s|^\s*[-*]\s|\|.+\||```|\$[^$]+\$|\[.+\]\(.+\))/m.test(t);

const DESCRIPTION = `Write on the board — the ONE way to put words and pictures on the canvas.
The board is the conversation; the sidebar is the log.

One thought = one call. A board note EXPLAINS one thing (an artifact, a decision, a
comparison); real content belongs in an artifact. What you pass decides what lands:
- {text} → a single Markdown note. It is a real file (${CHALK_DIR}/…md) you can
  Read/Grep/Edit later. near = what it is about (annotates line). reply_to = thread
  under another note; chain:true = auto-thread onto your latest note of the same tag.
- {nodes, shapes, edges, …} → a whole sketch in one call (comparison table, flow,
  mind map, detective board linking real artifacts). You describe STRUCTURE on a grid
  (1 cell = ${UNIT}px); the server does pixels and hand-drawn shapes. The sketch gets a
  #tag (read/select/erase as a group) and lands as STAGING until commit or turn end.
Placement — relations only, never pixels (the machine solves the spot and never refuses):
- place:{by:"<id|#tag|user|view>", side?, with?} — beside something, in the user's view
  (default), or continuing a #tag group. near alone also lands beside what it annotates.
- reply_to lands right below the note it answers; {tag, chain:true} continues your own
  line of thought; fork with {tag:"新名", open_lane:"<id>"}.
- The return says where it landed in words (right of X / under Y / in view) and whether
  it had to go elsewhere. The box grows with the content — never pass sizes.
- say = your words on the line this note draws (why it connects). Lines carry sentences,
  not just a type word: the user reads the board by its lines.
Node text carrying markdown marks defaults to format md (KaTeX $…$ and \`\`\`mermaid fences work).
Readability: user reads at 75–100% zoom — body text md/lg; one sketch fits one screen.
To change what is already on the board use edit_board — do not redraw.
Keep the chat reply to one line pointing here.`;

export function makeWriteOnBoardTool({ projectId, sharedRoot, sessionId, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, sessionId, ctx });
  // 流式预解算（2026-09-12）：agent-shared 在位置字段闭合那一拍调 solve，正文继续流时调 grow。
  // 挂在 ctx 上是因为流的那头只有 ctx（tool-input-stream.js），工具的依赖都在这一头。
  if (ctx && typeof ctx === 'object') {
    ctx.spotPreviewers = { ...(ctx.spotPreviewers || {}), mcp__nodesign__write_on_board: makePreviewer({ projectId, sharedRoot }) };
  }
  return tool('write_on_board', DESCRIPTION, SCHEMA, handler);
}

/**
 * 预解算：拿流式入参里已闭合的位置字段 + 已流出的正文，按落板同一套代码解一次落点，登记预留座，
 * 把真矩形推给前端（直播框立在那儿，落盘后不跳）。解不出（锚不在板上、开线名重复…）返回 null，
 * 前端退回自己的近似。署名按主 agent 算（角色线已停用；真落板仍按 extra 盖章）。
 */
export function makePreviewer({ projectId, sharedRoot }) {
  const solve = async (input, toolUseId) => {
    try {
      if (!projectId || !sharedRoot || !toolUseId || !input || typeof input !== 'object') return null;
      if (input.nodes || input.shapes || input.ink === 'hand') return null;
      const env = await makeChalkEnv({ projectId, sharedRoot, by: 'agent', exclude: [`live:${toolUseId}`] });
      const body = String(input.text || '').trim() || '…';
      const R = await resolveChalkSpot(env, { ...input }, body);   // 拷贝：解析会写 args.tag
      if (R.error) return null;
      const rect = { x: R.placed.x, y: R.placed.y, w: R.box.w, h: R.box.h, zone: R.zone };
      reserveSpot(projectId, toolUseId, { ...rect, wUnits: R.wUnits });
      return { ...rect, how: R.placed.how, side: R.placed.side };
    } catch { return null; }
  };
  const grow = (toolUseId, text) => {
    const r = getReservation(projectId, toolUseId);
    if (!r) return;
    const box = textBox(String(text || ''), 'md', { md: true, wUnits: r.wUnits || null });
    updateReservation(projectId, toolUseId, { h: Math.min(box.h, CARD_MAX_H) });
  };
  return { solve, grow };
}

function makeHandler({ projectId, sharedRoot, sessionId, ctx }) {
  return async function handler(args, extra) {
    // 署名：主 agent → 'agent'，常驻角色 → 它的 slug。权威是 harness 在派发时盖的章
    // （agent/actor-trail.js），不是角色文件里的自称 —— 那份文件模型能改。
    const by = byOf(extra);
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (!projectId || !sharedRoot) return err('No project bound.');
    // 直播中的板书框随视点上报进了障碍集（同轮下一次落位看得见它）；自己这条的直播框要剔掉
    const selfLive = toolUseIdOf(extra) ? [`live:${toolUseIdOf(extra)}`] : [];

    const nodesIn = args.nodes || [];
    const shapesIn = args.shapes || [];
    const edgesIn = args.edges || [];
    const hasSketch = nodesIn.length || shapesIn.length;
    if (args.text && hasSketch) {
      return err('text 是"单节点图"的简写，跟 nodes/shapes 二选一：一句话给 text，一张图把它写成一个 node。');
    }
    if (!args.text && !hasSketch) {
      return err('内容不能为空：请提供 text（一句话）或 nodes/shapes（一张图）。只想画线用 edit_board 的 add_edge。');
    }
    // 单节点图 = 一句话（统一模型的退化情形）：转文件本体那条路，语义字段全保
    if (!args.text && !args.title && nodesIn.length === 1 && !shapesIn.length && !edgesIn.length) {
      const n = nodesIn[0];
      // ⚠️ extra 必须往下传：署名是从 extra 里的 toolUseId 查回来的，
      // 这条自递归漏了它的话，角色用 `nodes:[一件]` 写的板会静默署成 'agent'。
      return handler({
        text: n.text, near: args.near, reply_to: args.reply_to, place: args.place, say: args.say,
        relation: args.relation, chain: args.chain, tag: args.tag, size: n.size,
      }, extra);
    }

    const env = await makeChalkEnv({ projectId, sharedRoot, by, exclude: selfLive });
    const { board, known, obstaclesOf, vp, fit, capW, vpRectFor, resolveAnchor, fuzzyNotes, placeNote, describeSpot, describeChalkWrite, visibleIn, resolvePlace } = env;
    void known; void capW; void resolvePlace; void visibleIn;

    // ───────────────────────── 件数 = 1：板书（文件本体） ─────────────────────────
    if (args.text) {
      let body = String(args.text).trim();
      if (!body) return err('正文不能为空。');
      // 控件围栏自愈（08-28 泉此方案）：角色把 nd:controls 写成裸文本开头 —— 语义无歧义
      // （正文以 nd:controls 起头且全文无围栏），替它补上，渲染层只认 ```nd:controls
      if (/^nd:controls\s*\n/.test(body) && !body.includes('```')) {
        body = '```nd:controls\n' + body.replace(/^nd:controls\s*\n/, '') + '\n```';
      }
      // 手写字（ink:'hand'，08-27 收编 create_on_board）：线程语义长在板书文件上
      if (args.ink === 'hand' && (args.chain || args.open_lane || args.reply_to)) {
        return err("ink:'hand' 是画布手写字（无文件本体），接不进线程 —— 要 chain/open_lane/reply_to 就用默认的 chalk。");
      }
      // 落位解析（open_lane / chain / near / reply_to / place → 真落点）在 write-on-board-resolve.js：
      // 同一份代码也给流式预解算用（位置字段一闭合就先解一次，见 previewChalkSpot）
      const R = await resolveChalkSpot(env, args, body);
      if (R.error) return err(R.error);
      const { replyToRaw, nearRaw, wUnits, zone, anchorId, parentId, replyRect, anchorRect, b2, laneFrom,
        placeRect, placeId, groupRect, groupTag, pl, obstacles, vpRect } = R;
      let { box, placed } = R;
      void replyToRaw; void nearRaw; void replyRect; void anchorRect;
      // ── flow（刀⑦ 2026-08-30）：长文由机器按段拆成一串卡大小的板书（拆件见
      // write-on-board-flow.js）。返回 null = 用不上（守卫不过/一块就装下），走正常路。
      if (args.flow && args.text) {
        const fr = await maybeFlowWrite({
          projectId, sharedRoot, sessionId, by, ctx, args, body, wUnits, zone,
          parentId, replyRect, anchorId, placeRect, placeId, groupRect, groupTag, b2, obstaclesOf,
          placeNote, vpRect, column: fit.column, stamp,
        });
        if (fr) return fr;
      }

      // 预告过的位置优先（2026-09-12）：流式时服务端已按同一套解算给过前端一个落点，直播框就立在
      // 那儿。落盘时只要那块地还空着就落回去，字不再跳；被占了（同轮别的东西先落了）才重解
      const rsv = takeReservation(projectId, toolUseIdOf(extra));
      if (rsv && (rsv.zone || '') === (zone || '') && !overlapIds({ x: rsv.x, y: rsv.y, w: box.w, h: box.h }, obstacles).length) {
        placed = { ...placed, x: rsv.x, y: rsv.y, pressed: [] };
      }

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
          hBindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}), ...(args.say ? { label: args.say } : {}) };
        }
        await patchBoard(projectId, { objects: hObjects, bindings: hBindings });
        const hRect = { x: Math.round(placed.x), y: Math.round(placed.y), w: box.w, h: box.h };
        try {
          ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: '写了一段手写字' });
          ctx?.emit?.(Events.boardFocus(hRect, { tag: args.tag || null, layer: zone, soft: true, actor: by !== 'agent' ? by : null }));
        } catch { /* fail-soft */ }
        return { content: [{ type: 'text', text:
          `Wrote handwritten note ${hid} — ${describeSpot(placed, { anchorId: placeId, groupTag })}.${fuzzyNotes.join('')}` }] };
      }

      // 状态表堵写口（2026-08-30）：这 tag 载重（set_vars/触发器/趋势线都读它），
      // 第一版就得是能解析的表 —— 坏表落盘比不落更坏。
      if (args.tag === STATE_TABLE_TAG) {
        const t = parseStateTable(String(body).replace(/\r\n?/g, '\n'));
        if (!t.ok) {
          return err(`⛔ tag「${STATE_TABLE_TAG}」是载重的，但这份正文里解析不出状态表（${t.error === 'no-table' ? '找不到「| 键 | 值 |」表' : t.error}）—— 什么都没写。正文放一张两列表（| 键 | 值 | ／ | --- | --- | ／ 一行一键）再来。`);
        }
      }
      const fileName = chalkFileName(body);
      const content = renderChalk({ body, by, anchor: anchorId, replyTo: parentId, tag: args.tag || null, sessionId: sessionId || null });
      const rel = await writeChalkFile(sharedRoot, fileName, content);

      const objects = { [rel]: {
        x: Math.round(placed.x), y: Math.round(placed.y), z: 1, w: box.w, h: box.h,
        zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
      } };
      const bindings = {};
      // 线上的话（2026-09-05 站主：线要能带 agent 自己的话，不只是「关联」「接着」）：
      // say 落在 near 线上，没有 near 就落在接楼线上；两条都没有就报回去别静默丢。
      let saySpent = false;
      if (anchorId) {
        const type = args.relation || (laneFrom ? 'flow' : 'annotates');
        // flow 是读序（旧 → 新）：锚在前板书在后；其余语义都是"这条说的是它"
        const [from, to] = type === 'flow' ? [anchorId, rel] : [rel, anchorId];
        bindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}), ...(args.say ? { label: args.say } : {}) };
        saySpent = !!args.say;
      }
      if (parentId) {
        bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: rel, by, material: 'pencil', ...(args.tag ? { tag: args.tag } : {}), ...(args.say && !saySpent ? { label: args.say } : {}) };
        saySpent = saySpent || !!args.say;
      }
      await patchBoard(projectId, {
        objects, bindings,
        // 线注册表照旧登记（read_board 的线清单/角色专线都靠它）：登记点 = 线头
        ...(laneFrom ? { lanes: { [args.tag]: {
          x: Math.round(placed.x), y: Math.round(placed.y), w: box.w,
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
      const lines = describeChalkWrite({
        rel, rect, board: b2, placed, box, args, vpRect,
        parentId, anchorId: placeId || anchorId, laneFrom, boardBefore: board, groupTag,
      });
      if (pl.groupMissing) lines.push(`（place.with:"${pl.groupMissing}" 那组还没有东西，所以这条按视口落位；它自己带了 tag 就是那组的第一条）`);
      if (args.say && !saySpent) lines.push('⚠ say 没有线可落（这条既没 near 也没 reply_to/chain）—— 话没上板。给它一个 near，或者用 edit_board add_edge{label}。');
      else if (args.say) lines.push(`Line says: 「${args.say}」`);
      return { content: [{ type: 'text', text: [...lines, ...fuzzyNotes].join('\n') }] };
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
      nodes.push({ key: n.id, text: n.text, format, size, font: n.font || 'kai', color: n.color || 'ink', at: n.at || null, w: n.w || null });
    }
    for (const n of nodes) {
      const box = textBox(n.text, n.size, { md: n.format === 'md', wUnits: capW(n.w) });
      n.w = box.w; n.h = box.h;
    }
    const titleNode = nodes.find(n => n.key === '__title');
    // 图内边（两端都是本图节点）：布局的结构输入 + 零线大图的提醒判据
    const nodeKeys = new Set(nodes.map(n => n.key));
    const innerEdges = edgesIn.filter(e => nodeKeys.has(e.from) && nodeKeys.has(e.to) && e.from !== e.to);
    const tpl = resolveTemplate(nodes.filter(n => n !== titleNode), { template: args.layout || 'auto', edges: innerEdges, column: fit.column });
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
        const bb = bboxOrZero([...pos.entries()].map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
        pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
      } else if (titleNode && tpl === 'free' && !titleNode.at) {
        const bb = bboxOrZero([...pos.entries()].filter(([k]) => k !== '__title').map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
        pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
      }
    };
    seatTitle();
    const rectOfNode = (key) => { const n = nodes.find(x => x.key === key); const p = pos.get(key); return n && p ? { x: p.x, y: p.y, w: n.w, h: n.h } : null; };

    // ── 形状（局部像素）：构建本体在 lib/sketch-shapes.js（08-27 棘轮拆件） ──
    const built = buildSketchShapes(shapesIn, { rectOfNode, isTaken: (id) => localIds.has(id), tag });
    if (built.error) return err(built.error);
    const shapes = built.shapes;
    // ── 线：端点校验跟 edit_board add_edge 同一道闸（endpointReal） ──
    const idOf = new Map();
    for (const n of nodes) idOf.set(n.key, `text:a${stamp()}`);
    for (const sh of shapes) idOf.set(sh.key, `scribble:a${stamp()}`);
    const resolveEnd = async (raw) => {
      if (idOf.has(raw)) return idOf.get(raw);
      const cid = normalizeCanvasId(raw);
      if (!cid) return null;
      return (await endpointReal(cid, board.objects || {}, board.zones, sharedRoot)) ? cid : null;
    };
    const bindings = {};
    const badEdges = [];
    for (const e of edgesIn) {
      const from = await resolveEnd(e.from); const to = await resolveEnd(e.to);
      if (!from || !to || from === to) { badEdges.push(`${e.from}→${e.to}`); continue; }
      bindings[`b:a${stamp()}`] = {
        type: e.type || 'link', from, to, by, material: e.material || 'pencil',
        ...(tag ? { tag } : {}), ...(staging ? { staging: true } : {}), ...(e.label ? { label: e.label } : {}),
      };
    }

    // ── 宏观落位：关系（near / place.by 贴放，place.with 续组，缺省视口） ──
    const local = bboxOrZero([
      ...nodes.map(n => ({ ...pos.get(n.key), w: n.w, h: n.h })),
      ...shapes.map(sh => sh.rect),
    ]);
    // 巨图不再硬拒（08-25 用户拍板移除上限）：照落，返回里强提醒拆分
    const oversized = local.w > SKETCH_MAX.w || local.h > SKETCH_MAX.h;
    let zone = '';
    let anchorRect = null;
    let sketchBase = board;
    let anchorId = null;
    if (args.near) {
      const a = await resolveAnchor(args.near, board);
      if (!a) return err(`锚点 ${args.near} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件 —— ${anchorMissHint(args.near, board)}。`);
      zone = a.zone; anchorId = a.anchorId;
      if (a.board) sketchBase = a.board;
      const e = sketchBase.objects[a.anchorId];
      anchorRect = { x: a.rect.x, y: a.rect.y, ...estimateSizeOn(sketchBase, a.anchorId, e) };
      if (a.rect.w > anchorRect.w) anchorRect = a.rect;   // tag 包络比单卡大就用包络
    }
    let placeRect = anchorRect; let placeId = anchorId; let groupRect = null; let groupTag = null;
    const pl = await resolvePlace(sketchBase, args.place);
    if (pl.error) return err(pl.error);
    if (pl.anchor) { placeRect = pl.anchor.rect; placeId = pl.anchor.id; if (!anchorId) zone = pl.anchor.zone; if (pl.anchor.board) sketchBase = pl.anchor.board; }
    else if (pl.view && args.place?.by === 'view') { placeRect = null; placeId = null; }
    if (pl.group) { groupRect = pl.group.rect; groupTag = pl.group.tag; if (!placeRect) zone = pl.group.zone; }
    const obstacles = obstaclesOf(sketchBase, zone);
    const vpRect = vpRectFor(zone);
    const sketchBox = { w: local.w + 24, h: local.h + 24 };
    const placed = placeNote(sketchBase, {
      box: sketchBox, anchorRect: placeRect, side: args.place?.side || null, groupRect,
      obstacles, vpRect, column: fit.column,
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
    const common = {
      z: 1, zone, by, seat: 'agent', ...(tag ? { tag } : {}), ...(staging ? { staging: true } : {}),
    };
    for (const n of nodes) {
      const p = pos.get(n.key);
      objects[idOf.get(n.key)] = {
        x: Math.round(p.x + ox), y: Math.round(p.y + oy), w: n.w, h: n.h, kind: 'text',
        data: { t: n.text, ...(n.format === 'md' ? { format: 'md' } : {}), font: TEXT_FONTS.includes(n.font) ? n.font : 'kai', size: n.size, color: n.color, lid: n.key },
        ...common,
      };
    }
    for (const sh of shapes) {
      objects[idOf.get(sh.key)] = { x: Math.round(sh.rect.x + ox), y: Math.round(sh.rect.y + oy), w: Math.round(sh.rect.w), h: Math.round(sh.rect.h), kind: 'scribble', data: { d: sh.d, color: sh.color, width: sh.width }, ...(sh.hug && idOf.get(sh.hug) ? { hug: idOf.get(sh.hug) } : {}), ...common };
    }
    // 登记这组用的布局：之后 reflow 按同一套模板重算（09-11）
    const saved = await patchBoard(projectId, { objects, bindings, ...(tag ? { layouts: { [tag]: { layout: tpl, ...(args.cols ? { cols: args.cols } : {}) } } } : {}) });
    const landed = Object.keys(objects).filter(id => saved.objects?.[id]).length;
    if (!landed) return err('草图被 board 拒了（内容或字段不合法）。');
    if (tag && nodes.length) { try { await applyFollows(projectId, { tag, newId: idOf.get(nodes[0].key) }); } catch { /* */ } }
    const world = { x: Math.round(local.x + ox), y: Math.round(local.y + oy), w: Math.round(local.w), h: Math.round(local.h) };
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: tag ? `画了一张草图 #${tag}` : '画了一个记号' });
      ctx?.emit?.(Events.boardFocus(world, { tag: tag || null, layer: zone, actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const lines = [
      `Sketch${tag ? ` #${tag}` : ''} landed${staging ? ' as STAGING (半透明)' : ''}: ${nodes.length} nodes, ${shapes.length} shapes, ${Object.keys(bindings).length} lines; layout ${tpl}; ${Math.round(local.w)}x${Math.round(local.h)}px — ${describeSpot(placed, { anchorId: placeId, groupTag })}.`,
      `ids: ${[...idOf].map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `Visible in the user's viewport: ${visibleIn(world, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
    ];
    lines.push(...lineCrossings(saved, { bindingIds: Object.keys(bindings) }, known));
    if (pl.groupMissing) lines.push(`（place.with:"${pl.groupMissing}" 那组还没有东西，所以按视口落位）`);
    if (args.say) lines.push('⚠ say 只给单条板书（它拉的那根线）；一张图的线上的话写在 edges[].label 里 —— 这次的 say 没上板。');
    if (oversized) lines.push(`⚠ 这张图 ${Math.round(local.w)}x${Math.round(local.h)} 世界像素，远超一屏（建议 ≤${SKETCH_MAX.w}x${SKETCH_MAX.h}）——用户要拖着镜头看。如果你是按**像素**想的坐标：nodes/shapes（含 path 的 d）全族单位是 24px 的格，数值除以 24 重画一版会正好；确实要这么大就拆成几张 tag 图用线连。`);
    // 零线大图提醒（08-27 用户报「草草一堆文字摊在那儿」）：软提醒不硬拒 ——
    // 但要说清楚这不是风格问题，是版面语言缺了一半
    if (nodesIn.length >= 3 && !innerEdges.length) {
      lines.push(`⚠ ${nodesIn.length} 件 0 线 —— 当前只是散落的文字，尚未构成图。线是版面的语言：`
        + `补 edges（谁连谁、什么关系，布局会按结构分层摆）；这些如果本是一条思路，`
        + `改走 {tag, chain:true} 让它长成线。`);
    }
    if (badEdges.length) lines.push(`Skipped ${badEdges.length} edge(s) with unknown endpoints: ${badEdges.slice(0, 6).join(', ')}`);
    // 触屏档宽是硬约束（横向滑动没人受得了），所以话要说在宽上
    if (world.w > fit.w || world.h > fit.h) lines.push(fit.column
      ? `⚠ Too big for a ${fit.lane} screen (${fit.screen.w}x${fit.screen.h}px). Keep each sketch ≤${fit.w} wide — anything wider means sideways scrolling. Stack the next one below, don't put it to the side.`
      : `⚠ Bigger than one screen${fit.screen ? ` (user's screen ${fit.screen.w}x${fit.screen.h}px → ${fit.w}x${fit.h} world px fits)` : ` (${fit.w}x${fit.h} fits)`} — split into two tagged sketches next time.`);
    if (vp?.zoom && vp.zoom < 0.75) lines.push(`User's zoom is ${vp.zoom} (<0.75): keep nodes md/lg and say in one line that there is a sketch on the board.`);
    lines.push(staging
      ? `Next: look_at_board {tag:"${tag}"} to check it, then edit_board {ops:[{op:"commit",tag:"${tag}"}]} (or it commits at turn end).`
      : `Next: look_at_board ${tag ? `{tag:"${tag}"}` : '{around: one of the ids}'} to check it.`);
    return { content: [{ type: 'text', text: [...lines, ...fuzzyNotes].join('\n') }] };
  };
}
