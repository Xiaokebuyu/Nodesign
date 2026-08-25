/**
 * mcp/tools/sketch-on-board.js —— sketch_on_board / finish_sketch（2026-08-23 黑板）
 *
 * 让 agent 把画布当黑板：一次调用落一整张示意图（节点 + 形状 + 线），而不是
 * 像 create_on_board 那样一条条写。设计要点（跟用户商定的形状）：
 *   - **没有几何容器**：一张图 = 一批带同一 #tag 的普通物件和线。read_board 按
 *     连通分量 + tag 分段读，用户可以整组选/整组擦，入座算法照旧绕着走
 *   - **两阶段**：落下来的默认是 staging（半透明，"正在画"），finish_sketch 或
 *     回合结束自动落定；落定只清 staging 位，tag 留着当逻辑分组
 *   - **结构不是像素**：agent 给模板 + 网格坐标（1 格 = 24px），服务端算像素与落位
 *   - **形状是涂鸦**：rect/ellipse/arrow… 在服务端生成带手绘抖动的路径，落成
 *     普通 scribble 对象，前端零改动；自由路径（path）也收，同一白名单
 *   - 线的材质缺省 pencil（手绘）—— 草图上的线是人顺手拉的；要丝线/墨线自己说
 *
 * 护栏：每回合 3 张图；每张 ≤ 40 节点 / 30 形状 / 60 线。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard, patchBoard, commitStaging, removeByTag, TEXT_FONTS } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId, tagEnvelope } from '../../../lib/canvas-id.js';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { UNIT, SKETCH_FIT, SKETCH_MAX, textBox, shapePath, layoutNodes, bboxOf, findSpot, fitFor } from '../../../lib/sketch-layout.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { Events } from '../../agent/events.js';

const MAX_NODES = 40;
const MAX_SHAPES = 30;
const MAX_EDGES = 60;

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;
const COLORS = ['ink', 'red', 'pencil', 'brass'];

const LOCAL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/, 'local id: letters/digits/_/-');
const GRID_PT = z.object({ x: z.number().min(-400).max(400), y: z.number().min(-400).max(400) });

export function makeSketchOnBoardTool({ projectId, ctx }) {
  const turnStamp = { turn: -1, count: 0 };   // 只记数（返回里不再报余额）
  return tool(
    'sketch_on_board',
    `Draw a whole sketch on the canvas in ONE call — notes, shapes and lines, laid out
together: a comparison table, a flow, a mind map, a detective board linking real
artifacts. The canvas is the blackboard; use it when thinking out loud with the user
would be clearer as a picture than as prose.

How it works
- You describe STRUCTURE; the server does pixels. Pick a layout template (column /
  row / grid / mindmap) or place nodes yourself on a grid (1 cell = ${UNIT}px, layout
  'free', at:{x,y}). Whole sketch lands beside \`near\` (a canvas id from read_board)
  or under the desktop's current content.
- nodes: plain handwriting or format:'md' (Markdown + KaTeX $…$ + \`\`\`mermaid fences).
  Use md for lists/tables/formulas; mermaid only for dense formal diagrams
  (sequence/state) — anything that should connect to real artifacts must be nodes+edges.
- shapes: rect / ellipse / circle / line / arrow / underline (hand-drawn look is
  applied for you) or path (raw SVG M/L/Q in local px) — all in grid units.
- edges: between local node ids and/or real canvas ids. type = the relation
  vocabulary (link/annotates/flow/contrast/derives-from/ref); material = ink (quiet
  archive line) / pencil (hand-drawn, default here) / yarn (detective red string + pins
  for hypotheses and evidence).
- Everything carries one #tag (a group): read_board {tag} reads just it, the user can
  select/erase it as a whole, finish_sketch commits or erases it.
- Items land as STAGING (half-transparent = you are still drawing). Call finish_sketch
  when done, or they commit automatically when the turn ends. Look at the result with
  look_at_board before you call it done — agent scribbles only make sense with eyes.
- Readability rule: the user reads the board at 80–100% zoom. Body text stays md/lg
  (sm only for captions ≤40 chars); one sketch ≤ ${SKETCH_FIT.w}x${SKETCH_FIT.h} world px (one screen at 80%),
  hard limit ${SKETCH_MAX.w}x${SKETCH_MAX.h} — split into two tagged sketches instead of one huge one.
- To change an existing sketch use edit_sketch (move/retext/add/remove by id) — do NOT
  erase and redraw the whole thing for a small change.
Per sketch: ≤${MAX_NODES} nodes, ${MAX_SHAPES} shapes, ${MAX_EDGES} edges (split big ones).`,
    {
      title: z.string().max(60).optional().describe('Optional heading written at the top of the sketch'),
      tag: z.string().regex(/^[\w一-鿿぀-ヿ-]{1,40}$/).optional()
        .describe('Group tag (letters/digits/_/-/CJK, ≤40). Default: auto "sk-<stamp>"'),
      near: z.string().max(300).optional().describe('Canvas id to place the sketch beside (right side; falls back to below)'),
      layout: z.enum(['auto', 'free', 'column', 'row', 'grid', 'mindmap']).optional()
        .describe('auto = free if any node has at, else column (≤4) / grid'),
      cols: z.number().int().min(1).max(8).optional().describe('grid columns'),
      staging: z.boolean().optional().describe('Default true. false = land committed (solid) immediately'),
      nodes: z.array(z.object({
        id: LOCAL_ID.describe('Local id to reference from edges/shapes'),
        text: z.string().min(1).max(4000),
        format: z.enum(['plain', 'md']).optional(),
        size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
        font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(),
        color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(),
        at: GRID_PT.optional().describe('Grid position (layout free); top-left of the node'),
        w: z.number().min(3).max(40).optional().describe('Width in grid units (md nodes; default by content; ≤40 = 960px. Prefer ≤22 (528px): paragraphs read better growing down than wide)'),
      })).max(MAX_NODES).optional(),
      shapes: z.array(z.object({
        id: LOCAL_ID.optional(),
        kind: z.enum(['rect', 'ellipse', 'circle', 'line', 'arrow', 'underline', 'path']),
        at: GRID_PT.optional().describe('Grid position (top-left for rect/ellipse; start point for line/arrow). Or use around:'),
        around: LOCAL_ID.optional().describe('rect/ellipse/circle/underline: wrap this node (pad applied) instead of at/w/h'),
        w: z.number().min(0).max(200).optional().describe('grid units'),
        h: z.number().min(0).max(200).optional().describe('grid units'),
        to: GRID_PT.optional().describe('line/arrow end point (grid)'),
        toNode: LOCAL_ID.optional().describe('line/arrow: aim at this node\'s center instead of to'),
        d: z.string().max(8000).optional().describe('path kind: SVG path (M/L/Q/Z only) in local px'),
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
    },
    async (args) => {
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
      // 回合闸 08-23 用户拍板先不设（「别设置限制吧先」）：只记数不拦
      const turn = ctx?.runId ?? -1;
      if (turnStamp.turn !== turn) { turnStamp.turn = turn; turnStamp.count = 0; }

      const nodesIn = args.nodes || [];
      const shapesIn = args.shapes || [];
      const edgesIn = args.edges || [];
      if (!nodesIn.length && !shapesIn.length) return err('空图不落板：至少给一个节点或形状。');
      const tag = args.tag || `sk-${stamp()}`;
      const staging = args.staging !== false;

      // ── 节点身位 ──
      const localIds = new Set();
      const nodes = [];
      if (args.title) {
        nodes.push({ key: '__title', text: `## ${args.title}`, format: 'md', size: 'md', font: 'kai', color: 'ink', at: null, w: null });
      }
      for (const n of nodesIn) {
        if (localIds.has(n.id)) return err(`节点 id 重复：${n.id}`);
        localIds.add(n.id);
        // 可读性规范：正文不低于 md（0.8 倍下 12.8 屏幕像素是底线）；sm 只给 ≤40 字的题注
        const size = (n.size === 'sm' && n.text.length > 40) ? 'md' : (n.size || 'md');
        nodes.push({ key: n.id, text: n.text, format: n.format || 'plain', size, font: n.font || 'pen', color: n.color || 'ink', at: n.at || null, w: n.w || null });
      }
      for (const n of nodes) {
        const box = textBox(n.text, n.size, { md: n.format === 'md', wUnits: n.w });
        n.w = box.w; n.h = box.h;
      }
      // 标题永远在最上面：free 模式给它 (0,-2)，模板模式它就是第一个
      const titleNode = nodes.find(n => n.key === '__title');
      let tpl = args.layout || 'auto';
      if (tpl === 'auto') tpl = nodes.some(n => n.at) ? 'free' : (nodes.length - (titleNode ? 1 : 0) <= 4 ? 'column' : 'grid');
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

      // ── 形状（局部像素）──
      const shapes = [];
      for (let i = 0; i < shapesIn.length; i += 1) {
        const s = shapesIn[i];
        const sid = s.id || `s${i + 1}`;
        if (localIds.has(sid) || shapes.some(x => x.key === sid)) return err(`形状 id「${sid}」跟节点/别的形状重名（形状缺省叫 s1,s2…，节点别用这类名）`);
        const seed = `${tag}:${sid}`;
        const color = COLORS.includes(s.color) ? s.color : (s.kind === 'arrow' || s.kind === 'line' ? 'ink2' : 'ink');
        const width = s.width || 2;
        let rect; let d;
        if (s.kind === 'path') {
          if (!s.d || !/^[\dMLQCZ ,.\-eE]+$/.test(s.d)) return err(`形状 ${sid}：path 只收 M/L/Q/Z 与数字`);
          // 自由路径：算它的包围盒，平移到 (at 或 0,0)
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

      // ── 先分配 id、解析线 ──
      // 线要先于落位算：一条连到真实产物卡的线会改变**主角判断**（手画线 +0.5 焦点分），
      // 那张卡可能因此放大 1.5 倍 —— 落位必须按"线画上去之后"的尺寸避让
      // （08-23 首跑真踩：草图连了一条丝线到纸本站，纸本当场成主角，身体盖住半张图）。
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const idOf = new Map();     // local → canvas id
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
          type: e.type || 'link', from, to, by: 'agent', material: e.material || 'pencil', tag,
          ...(staging ? { staging: true } : {}), ...(e.label ? { label: e.label } : {}),
        };
      }
      // 落位用"线画上之后"的板来估尺寸（主角可能换人）
      const after = { ...board, bindings: { ...(board.bindings || {}), ...bindings } };

      // ── 宏观落位 ──
      const local = bboxOf([
        ...nodes.map(n => ({ ...pos.get(n.key), w: n.w, h: n.h })),
        ...shapes.map(sh => sh.rect),
      ]);
      let zone = '';
      let anchor = null;
      if (args.near) {
        const nid = normalizeCanvasId(args.near);
        const e = nid ? board.objects?.[nid] : null;
        if (e && Number.isFinite(e.x)) {
          zone = layerOf(nid, e, known);
          anchor = { x: e.x, y: e.y, ...estimateSizeOn(after, nid, e) };
        } else {
          // near 也认 tag（08-23 案，同 write_on_board）
          const env = tagEnvelope(board, args.near, (id2, e2) => estimateSizeOn(after, id2, e2));
          if (!env) return err(`锚点 ${args.near} 还没有座位，也不是板上任何 tag（read_board 里看不到就锚不上）。`);
          zone = layerOf(env.anchorId, board.objects[env.anchorId], known);
          anchor = { x: env.x, y: env.y, w: env.w, h: env.h };
        }
      }
      const obstacles = [];
      let contentBottom = 0;
      for (const [id, e] of Object.entries(board.objects || {})) {
        if (!Number.isFinite(e?.x) || layerOf(id, e, known) !== zone) continue;
        const r = { x: e.x, y: e.y, ...estimateSizeOn(after, id, e) };
        obstacles.push(r); contentBottom = Math.max(contentBottom, r.y + r.h);
      }
      if (!zone) for (const zz of Object.values(board.zones || {})) if (Number.isFinite(zz?.y)) contentBottom = Math.max(contentBottom, zz.y + 240);
      // 尺寸规范：硬上限直接拒（一张图说一件事），推荐上限以上给提醒
      if (local.w > SKETCH_MAX.w || local.h > SKETCH_MAX.h) {
        return err(`这张图太大了（${Math.round(local.w)}x${Math.round(local.h)} 世界像素，上限 ${SKETCH_MAX.w}x${SKETCH_MAX.h}）：用户在 80%~100% 缩放下看不全。拆成两张（各自一个 tag，之间用线连），或减节点/缩 w。`);
      }
      // 用户视口（同一层才算；黑板是主窗口时画在他眼前）+ 按他的屏幕算"一屏"
      const vp = getViewpoint(projectId);
      const vpRect = (vp && (vp.layer || '') === zone && vp.camera) ? vp.camera : null;
      const fit = fitFor(vp);
      const spot = findSpot({ w: local.w + 24, h: local.h + 24, near: anchor, obstacles, contentBottom, viewport: vpRect });
      const ox = spot.x - local.x + 12; const oy = spot.y - local.y + 12;

      // ── 落盘 ──
      const objects = {};
      const common = { z: 1, zone, by: 'agent', seat: 'agent', tag, ...(staging ? { staging: true } : {}) };
      for (const n of nodes) {
        const p = pos.get(n.key);
        objects[idOf.get(n.key)] = {
          x: Math.round(p.x + ox), y: Math.round(p.y + oy), w: n.w, h: n.h, kind: 'text',
          // lid：agent 当初给这个节点起的局部名。留着它，后续 edit_sketch 就能
          // 直接用 `linfan` 而不是回头抄 `text:amt7…`（08-24 信箱：7 条 add_edge 全灭）
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
      turnStamp.count += 1;
      const world = { x: Math.round(local.x + ox), y: Math.round(local.y + oy), w: Math.round(local.w), h: Math.round(local.h) };
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `画了一张草图 #${tag}` });
        // 镜头提示（前端只在黑板模式跟随；不是劫持，是"黑板是主窗口"的约定）
        ctx?.emit?.(Events.boardFocus(world, { tag, layer: zone }));
      } catch { /* fail-soft */ }
      const lines = [
        `Sketch #${tag} landed${staging ? ' as STAGING (半透明)' : ''}: ${Object.keys(objects).length - shapes.length} nodes, ${shapes.length} shapes, ${Object.keys(bindings).length} lines; layout ${tpl}; at world (${world.x},${world.y}) ${world.w}x${world.h}${anchor ? ` (${spot.side} of ${args.near})` : ' (below current content)'}.`,
        `ids: ${[...idOf].map(([k, v]) => `${k}=${v}`).join(', ')}`,
      ];
      if (badEdges.length) lines.push(`Skipped ${badEdges.length} edge(s) with unknown endpoints: ${badEdges.slice(0, 6).join(', ')}`);
      if (world.w > fit.w || world.h > fit.h) lines.push(`⚠ Bigger than one screen at 80% zoom${fit.screen ? ` (user's screen ${fit.screen.w}x${fit.screen.h}px → ${fit.w}x${fit.h} world px fits)` : ` (${fit.w}x${fit.h} fits)`} — the user will have to pan. Split into two tagged sketches (side by side or stacked) next time.`);
      if (vp?.zoom && vp.zoom < 0.8) lines.push(`User's zoom is ${vp.zoom} (<0.8): text this size is small on their screen. Keep nodes md/lg and say in one line that there is a sketch on the board.`);
      lines.push(spot.side === 'viewport' ? 'Placed inside the user\'s current viewport.' : `Placed ${spot.side === 'bottom' ? 'below current content' : spot.side + ' of the anchor'}${vpRect ? ' (no room in the user\'s viewport)' : ''}.`);
      lines.push(staging
        ? 'Next: look_at_board {tag} to check it, then finish_sketch {tag} (or it commits at turn end). Mention the sketch to the user in one line.'
        : 'Next: look_at_board {tag} to check it.');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

export function makeFinishSketchTool({ projectId, ctx }) {
  return tool(
    'finish_sketch',
    `Commit a staging sketch (make it solid) — or erase it. Pass the #tag from
sketch_on_board; omit tag to commit everything still staging. erase:true deletes the
whole group (its notes/shapes/lines; real artifact cards only lose the tag).`,
    {
      tag: z.string().max(40).optional(),
      erase: z.boolean().optional(),
    },
    async ({ tag, erase }) => {
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      if (erase) {
        if (!tag) return { content: [{ type: 'text', text: 'erase needs a tag.' }], isError: true };
        const { removed } = await removeByTag(projectId, tag);
        try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `擦掉了草图 #${tag}` }); } catch { /* */ }
        return { content: [{ type: 'text', text: `Erased #${tag}: ${removed} item(s)/line(s) removed.` }] };
      }
      const { committed } = await commitStaging(projectId, { tag: tag || null });
      if (committed) { try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `草图落定${tag ? ` #${tag}` : ''}` }); } catch { /* */ } }
      return { content: [{ type: 'text', text: committed ? `Committed ${committed} item(s)${tag ? ` of #${tag}` : ''}.` : 'Nothing was staging.' }] };
    },
  );
}
